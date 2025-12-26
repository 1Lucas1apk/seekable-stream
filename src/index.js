import { Readable } from 'stream';
import { URL } from 'url';
import http from 'http';
import https from 'https';
import fsPromises from 'fs/promises';
import { createReadStream } from 'fs'; 
import CodecParser from 'codec-parser';
import { Decoder } from 'ts-ebml';

export class SeekError extends Error {
    constructor(code, message, hint = '', traceId = '', resolvedRanges = []) {
        super(message);
        this.name = 'SeekError';
        this.code = code;
        this.hint = hint;
        this.resolvedRanges = resolvedRanges;
    }
}

async function makeHttpRequest(url, options, customRequestFn = null) {
    if (customRequestFn) {
        return customRequestFn(url, options);
    }

    let currentUrl = new URL(url);
    let redirectCount = 0;
    const MAX_REDIRECTS = 10;

    while (redirectCount <= MAX_REDIRECTS) {
        const client = currentUrl.protocol === 'http:' ? http : https;

        const res = await new Promise((resolve, reject) => {
            const req = client.request(currentUrl, options, (res) => {
                resolve(res);
            });
            req.on('error', (err) => {
                reject(err);
            });
            req.end();
        });

        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            currentUrl = new URL(res.headers.location, currentUrl.href);
            redirectCount++;
        } else {
            return res;
        }
    }

    throw new SeekError('TOO_MANY_REDIRECTS', 'Exceeded maximum number of redirects');
}

async function fetchWithRange(url, start, end, customHeaders = {}, customRequestFn = null, chunkSize = 512 * 1024) {

    if (start > end && end !== Infinity) {
        return Buffer.alloc(0);
    }

    const headers = { ...customHeaders, 'Range': `bytes=${start}-${end}` };
    const response = await makeHttpRequest(url, { headers }, customRequestFn);
    
    if (response.statusCode === 416) {
        response.resume();
        return Buffer.alloc(0);
    }

    if (response.statusCode !== 206 && response.statusCode !== 200) {
        response.resume();
        throw new SeekError('UNEXPECTED_HTTP_STATUS', `Unexpected status: ${response.statusCode}`);
    }

    const allChunks = [];
    let bytesRead = 0;
    const targetLength = (end === Infinity) ? Infinity : (end - start + 1);

    for await (const chunk of response) {
        const remaining = targetLength - bytesRead;
        if (remaining <= 0 && targetLength !== Infinity) break;
        
        if (targetLength !== Infinity && chunk.length > remaining) {
            allChunks.push(chunk.slice(0, remaining));
            bytesRead += remaining;
            break;
        } else {
            allChunks.push(chunk);
            bytesRead += chunk.length;
        }
    }
    
    if (response.statusCode === 200) response.destroy();
    
    return Buffer.concat(allChunks);
}

function createLocalFileStream(filePath, start, end) {
    const stream = createReadStream(filePath, { start, end });
    return stream;
}

async function* generateHttpChunks(parsedUrl, start, end, customHeaders, customRequestFn, chunkSize) {
    let currentPos = start;

    while (currentPos <= end || end === Infinity) {
        
        const chunkEnd = (end === Infinity) ? currentPos + chunkSize - 1 : Math.min(currentPos + chunkSize - 1, end);
        
        if (currentPos > chunkEnd && end !== Infinity) {
            break;
        }
        
        const headers = { ...customHeaders, Range: `bytes=${currentPos}-${chunkEnd}` };
        
        const response = await makeHttpRequest(parsedUrl, { headers }, customRequestFn);

        if (response.statusCode === 416) {
            break;
        }
        
        if (response.statusCode !== 206) {
            if (response.statusCode === 200 && start === 0) {
                 for await (const chunk of response) {
                     yield chunk;
                 }
                 break;
            }
            break; 
        }

        currentPos = chunkEnd + 1;
        
        let hasData = false;
        for await (const chunk of response) {
            yield chunk;
            hasData = true;
        }
        
        if (!hasData) {
            break;
        }
    }
}

function createHttpStream(parsedUrl, start, end, customHeaders = {}, customRequestFn = null, chunkSize = 256 * 1024) {
    return Readable.from(generateHttpChunks(parsedUrl, start, end, customHeaders, customRequestFn, chunkSize));
}

function detectContentType(buffer, originalMime, urlString = '') {
    if (!buffer || buffer.length < 4) return originalMime;
    
    const hex = buffer.toString('hex', 0, 4);
    const ascii = buffer.toString('ascii', 0, 4);

    if (ascii === 'fLaC') return 'audio/flac';
    
    if (buffer[0] === 0xFF && (buffer[1] & 0xF0) === 0xF0) return 'audio/aac';

    if (hex.startsWith('494433')) {
        const ext = urlString.split('?')[0].split('.').pop().toLowerCase();
        if (ext === 'aac' || (originalMime && originalMime.includes('aac'))) return 'audio/aac';
        return 'audio/mpeg'; 
    }

    if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) return 'audio/mpeg';
    
    if (buffer.length >= 8 && buffer.slice(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4';
    
    if (!originalMime || originalMime === 'application/octet-stream') {
        const ext = urlString.split('?')[0].split('.').pop().toLowerCase();
        const mimeMap = {
            'mp3': 'audio/mpeg',
            'aac': 'audio/aac',
            'flac': 'audio/flac',
            'webm': 'audio/webm',
            'opus': 'audio/opus',
            'm4a': 'audio/mp4',
            'mp4': 'audio/mp4',
            'ogg': 'audio/ogg'
        };
        if (mimeMap[ext]) return mimeMap[ext];
    }

    return originalMime;
}

async function findMp4Headers(url, fileSize, httpHeaders, customRequestFn) {
    let offset = 0;
    const MAX_HEADER_SIZE = 10 * 1024 * 1024; 
    let iterations = 0;
    let ftyp = null;
    let moov = null;

    while (offset < fileSize && iterations < 100) {
        iterations++;
        const headerBuffer = await fetchWithRange(url, offset, offset + 15, httpHeaders, customRequestFn);
        if (headerBuffer.length < 8) break;

        let size = headerBuffer.readUInt32BE(0);
        const type = headerBuffer.toString('ascii', 4, 8);
        let headerSize = 8;

        if (size === 1) { 
            if (headerBuffer.length < 16) break;
            const high = headerBuffer.readUInt32BE(8);
            const low = headerBuffer.readUInt32BE(12);
            size = (high * 4294967296) + low;
            headerSize = 16;
        }

        if (size === 0) size = fileSize - offset;

        if (type === 'ftyp' && !ftyp) {
            ftyp = await fetchWithRange(url, offset, offset + size - 1, httpHeaders, customRequestFn);
        } else if (type === 'moov' && !moov) {
            if (size <= MAX_HEADER_SIZE) {
                moov = await fetchWithRange(url, offset, offset + size - 1, httpHeaders, customRequestFn);
            }
        }

        if (ftyp && moov) break;
        offset += size;
    }
    return { ftyp, moov };
}

// Busca o offset do sample de áudio correspondente a um tempo específico
function getMp4AudioSampleOffsetByTime(moovBuffer, targetTimeMs) {
    let offset = 0;
    while (offset <= moovBuffer.length - 8) {
        let size = moovBuffer.readUInt32BE(offset);
        const type = moovBuffer.toString('ascii', offset + 4, offset + 8);
        if (size <= 0) break;

        if (type === 'trak') {
            const trak = moovBuffer.slice(offset + 8, offset + size);
            const mdiaIdx = trak.indexOf('mdia');
            if (mdiaIdx !== -1) {
                const hdlrIdx = trak.indexOf('hdlr', mdiaIdx);
                if (hdlrIdx !== -1) {
                    const handler = trak.slice(hdlrIdx + 12, hdlrIdx + 16).toString('ascii');
                    if (handler === 'soun') {
                        // 1. Timescale (mdhd)
                        const mdhdIdx = trak.indexOf('mdhd', mdiaIdx);
                        if (mdhdIdx === -1) break;
                        const version = trak.readUInt8(mdhdIdx + 8);
                        const timescale = trak.readUInt32BE(mdhdIdx + (version === 1 ? 28 : 20));
                        const targetUnits = (targetTimeMs / 1000) * timescale;

                        // 2. Tabelas (stbl)
                        const stblIdx = trak.indexOf('stbl', mdiaIdx);
                        if (stblIdx === -1) break;
                        const stbl = trak.slice(stblIdx + 8);

                        // Helper para ler tabelas
                        const readTable = (buffer, pos, type) => {
                            if (pos + 16 > buffer.length) return [];
                            const count = buffer.readUInt32BE(pos + 12);
                            const entries = [];
                            for (let i = 0; i < count; i++) {
                                if (type === 'stts') {
                                    if (pos + 24 + (i * 8) > buffer.length) break;
                                    entries.push({
                                        count: buffer.readUInt32BE(pos + 16 + (i * 8)),
                                        delta: buffer.readUInt32BE(pos + 20 + (i * 8))
                                    });
                                } else if (type === 'stsc') {
                                    if (pos + 28 + (i * 12) > buffer.length) break;
                                    entries.push({
                                        firstChunk: buffer.readUInt32BE(pos + 16 + (i * 12)),
                                        samplesPerChunk: buffer.readUInt32BE(pos + 20 + (i * 12)),
                                        sampleDescId: buffer.readUInt32BE(pos + 24 + (i * 12))
                                    });
                                } else if (type === 'stco') {
                                    if (pos + 20 + (i * 4) > buffer.length) break;
                                    entries.push(buffer.readUInt32BE(pos + 16 + (i * 4)));
                                } else if (type === 'co64') {
                                    if (pos + 24 + (i * 8) > buffer.length) break;
                                    const high = buffer.readUInt32BE(pos + 16 + (i * 8));
                                    const low = buffer.readUInt32BE(pos + 20 + (i * 8));
                                    entries.push((high * 4294967296) + low);
                                }
                            }
                            return entries;
                        };

                        // 3. STTS (Time to Sample)
                        const sttsIdx = stbl.indexOf('stts');
                        if (sttsIdx === -1) break;
                        const stts = readTable(stbl, sttsIdx, 'stts');
                        
                        let currentSampleIdx = 0;
                        let currentTime = 0;
                        for (const entry of stts) {
                            if (currentTime + (entry.count * entry.delta) >= targetUnits) {
                                const samplesNeeded = Math.floor((targetUnits - currentTime) / entry.delta);
                                currentSampleIdx += samplesNeeded;
                                break;
                            }
                            currentTime += (entry.count * entry.delta);
                            currentSampleIdx += entry.count;
                        }

                        // 4. STSC (Sample to Chunk)
                        const stscIdx = stbl.indexOf('stsc');
                        if (stscIdx === -1) break;
                        const stsc = readTable(stbl, stscIdx, 'stsc');
                        
                        let chunkIdx = 1;
                        let samplesAcc = 0;
                        let foundChunk = false;

                        for (let i = 0; i < stsc.length; i++) {
                            const entry = stsc[i];
                            const nextEntryChunk = (i + 1 < stsc.length) ? stsc[i+1].firstChunk : Infinity;
                            const numChunks = nextEntryChunk - entry.firstChunk;
                            
                            const samplesInBlock = numChunks * entry.samplesPerChunk;

                            if (currentSampleIdx < samplesAcc + samplesInBlock) {
                                const remainingSamples = currentSampleIdx - samplesAcc;
                                const chunkOffset = Math.floor(remainingSamples / entry.samplesPerChunk);
                                chunkIdx = entry.firstChunk + chunkOffset;
                                foundChunk = true;
                                break;
                            }
                            
                            samplesAcc += (numChunks === Infinity ? 0 : samplesInBlock); 
                            if (numChunks === Infinity && !foundChunk) {
                                 const remainingSamples = currentSampleIdx - samplesAcc;
                                 const chunkOffset = Math.floor(remainingSamples / entry.samplesPerChunk);
                                 chunkIdx = entry.firstChunk + chunkOffset;
                                 foundChunk = true;
                            }
                        }

                        // 5. STCO/CO64 (Chunk Offset)
                        const stcoIdx = stbl.indexOf('stco');
                        const co64Idx = stbl.indexOf('co64');
                        let chunkOffsets;
                        if (stcoIdx !== -1) chunkOffsets = readTable(stbl, stcoIdx, 'stco');
                        else if (co64Idx !== -1) chunkOffsets = readTable(stbl, co64Idx, 'co64');
                        
                        if (chunkOffsets && chunkOffsets[chunkIdx - 1]) {
                            return chunkOffsets[chunkIdx - 1];
                        }
                    }
                }
            }
        } else if (['moov', 'mdia', 'minf'].includes(type)) {
             const found = getMp4AudioSampleOffsetByTime(moovBuffer.slice(offset + 8, offset + size), targetTimeMs);
             if (found) return found;
        }
        offset += size;
    }
    return null;
}

// Mantido para compatibilidade se needed, mas o foco é getMp4AudioSampleOffsetByTime
function getMp4AudioSamples(moovBuffer) {
    let samples = [];
    let pos = 0;
    while (pos <= moovBuffer.length - 8) {
        let size = moovBuffer.readUInt32BE(pos);
        const type = moovBuffer.toString('ascii', pos + 4, pos + 8);
        
        if (size < 8) break; 
        if (pos + size > moovBuffer.length) break; 

        if (type === 'trak') {
            const trakBuffer = moovBuffer.slice(pos + 8, pos + size);
            const mdiaIdx = trakBuffer.indexOf('mdia');
            if (mdiaIdx !== -1) {
                const hdlrIdx = trakBuffer.indexOf('hdlr', mdiaIdx);
                if (hdlrIdx !== -1 && hdlrIdx + 16 <= trakBuffer.length) {
                    const handler = trakBuffer.slice(hdlrIdx + 12, hdlrIdx + 16).toString('ascii');
                    if (handler === 'soun') {
                        const stblIdx = trakBuffer.indexOf('stbl');
                        if (stblIdx !== -1) {
                            const stbl = trakBuffer.slice(stblIdx + 8); 
                            
                            const chunkOffsets = [];
                            let stcoPos = stbl.indexOf('stco'); 
                            if (stcoPos !== -1 && stcoPos + 16 <= stbl.length) {
                                const count = stbl.readUInt32BE(stcoPos + 12);
                                for (let i = 0; i < count; i++) {
                                    if (stcoPos + 16 + (i * 4) + 4 <= stbl.length) {
                                        chunkOffsets.push(stbl.readUInt32BE(stcoPos + 16 + (i * 4)));
                                    } else break;
                                }
                            } else {
                                const co64Pos = stbl.indexOf('co64');
                                if (co64Pos !== -1 && co64Pos + 16 <= stbl.length) {
                                    const count = stbl.readUInt32BE(co64Pos + 12);
                                    for (let i = 0; i < count; i++) {
                                        if (co64Pos + 20 + (i * 8) + 4 <= stbl.length) {
                                            const high = stbl.readUInt32BE(co64Pos + 16 + (i * 8));
                                            const low = stbl.readUInt32BE(co64Pos + 20 + (i * 8));
                                            chunkOffsets.push((high * 4294967296) + low);
                                        } else break;
                                    }
                                }
                            }

                            const sampleSizes = [];
                            const stszPos = stbl.indexOf('stsz');
                            if (stszPos !== -1 && stszPos + 20 <= stbl.length) {
                                const uniformSize = stbl.readUInt32BE(stszPos + 12);
                                const count = stbl.readUInt32BE(stszPos + 16);
                                if (uniformSize !== 0) {
                                    for (let i = 0; i < count; i++) sampleSizes.push(uniformSize);
                                } else {
                                    for (let i = 0; i < count; i++) {
                                        if (stszPos + 20 + (i * 4) + 4 <= stbl.length) {
                                            sampleSizes.push(stbl.readUInt32BE(stszPos + 20 + (i * 4)));
                                        } else break;
                                    }
                                }
                            }

                            const stscEntries = [];
                            const stscPos = stbl.indexOf('stsc');
                            if (stscPos !== -1 && stscPos + 16 <= stbl.length) {
                                const count = stbl.readUInt32BE(stscPos + 12);
                                for (let i = 0; i < count; i++) {
                                    if (stscPos + 16 + (i * 12) + 12 <= stbl.length) {
                                        stscEntries.push({
                                            firstChunk: stbl.readUInt32BE(stscPos + 16 + (i * 12)),
                                            samplesPerChunk: stbl.readUInt32BE(stscPos + 20 + (i * 12))
                                        });
                                    } else break;
                                }
                            }

                            let currentSampleIdx = 0;
                            for (let i = 0; i < chunkOffsets.length; i++) {
                                const chunkIdx = i + 1;
                                const offset = chunkOffsets[i];
                                
                                let entry = stscEntries[0];
                                for (let k = 0; k < stscEntries.length; k++) {
                                    if (chunkIdx >= stscEntries[k].firstChunk) {
                                        entry = stscEntries[k];
                                    } else {
                                        break; 
                                    }
                                }

                                if (entry) { 
                                    let currentOffsetInChunk = 0;
                                    for (let j = 0; j < entry.samplesPerChunk; j++) {
                                        if (currentSampleIdx < sampleSizes.length) {
                                            const size = sampleSizes[currentSampleIdx];
                                            samples.push({ offset: offset + currentOffsetInChunk, size: size });
                                            currentOffsetInChunk += size;
                                            currentSampleIdx++;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else if (['moov', 'mdia', 'minf'].includes(type)) {
             const sub = getMp4AudioSamples(moovBuffer.slice(pos + 8, pos + size));
             samples.push(...sub);
        }
        pos += size;
    }
    return samples;
}

function patchAndFreeMp4(buffer, delta, durationMs, globalTimescale) {
    let pos = 0;
    while (pos <= buffer.length - 8) {
        let size = buffer.readUInt32BE(pos);
        const type = buffer.toString('ascii', pos + 4, pos + 8);
        if (size <= 0) break;

        if (type === 'mvhd') {
            const version = buffer.readUInt8(pos + 8);
            const timescale = buffer.readUInt32BE(pos + (version === 1 ? 28 : 20));
            const newDur = Math.max(0, Math.floor((durationMs / 1000) * timescale));
            if (version === 1) {
                buffer.writeUInt32BE(Math.floor(newDur / 4294967296), pos + 32);
                buffer.writeUInt32BE(newDur % 4294967296, pos + 36);
            } else {
                buffer.writeUInt32BE(Math.min(0xFFFFFFFF, newDur), pos + 24);
            }
        } else if (type === 'mdhd') {
            const version = buffer.readUInt8(pos + 8);
            const timescale = buffer.readUInt32BE(pos + (version === 1 ? 28 : 20));
            const newDur = Math.max(0, Math.floor((durationMs / 1000) * timescale));
            
            if (version === 1) {
                buffer.writeUInt32BE(Math.floor(newDur / 4294967296), pos + 32);
                buffer.writeUInt32BE(newDur % 4294967296, pos + 36);
            } else {
                buffer.writeUInt32BE(Math.min(0xFFFFFFFF, newDur), pos + 24);
            }
        } else if (type === 'tkhd') {
            const version = buffer.readUInt8(pos + 8);
            const durationOffset = pos + (version === 1 ? 36 : 28);
            const newDur = Math.max(0, Math.floor((durationMs / 1000) * globalTimescale));
            
            if (version === 1) {
                buffer.writeUInt32BE(Math.floor(newDur / 4294967296), durationOffset);
                buffer.writeUInt32BE(newDur % 4294967296, durationOffset + 4);
            } else {
                buffer.writeUInt32BE(Math.min(0xFFFFFFFF, newDur), durationOffset);
            }
        } else if (type === 'trak') {
            const content = buffer.subarray(pos + 8, pos + size);
            const mdiaIdx = content.indexOf('mdia');
            let isAudio = false;
            if (mdiaIdx !== -1) {
                const hdlrIdx = content.indexOf('hdlr', mdiaIdx);
                if (hdlrIdx !== -1) {
                    const handlerType = content.slice(hdlrIdx + 12, hdlrIdx + 16).toString('ascii');
                    if (handlerType === 'soun') isAudio = true;
                }
            }
            
            if (!isAudio) {
                buffer.write('free', pos + 4);
            } else {
                patchAndFreeMp4(content, delta, durationMs, globalTimescale);
            }
        } else if (type === 'stco') {
            const count = buffer.readUInt32BE(pos + 12);
            for (let i = 0; i < count; i++) {
                const current = buffer.readUInt32BE(pos + 16 + (i * 4));
                buffer.writeUInt32BE(Math.max(0, current + delta), pos + 16 + (i * 4));
            }
        } else if (type === 'co64') {
            const count = buffer.readUInt32BE(pos + 12);
            for (let i = 0; i < count; i++) {
                const high = buffer.readUInt32BE(pos + 16 + (i * 8));
                const low = buffer.readUInt32BE(pos + 20 + (i * 8));
                const current = (high * 4294967296) + low;
                const updated = Math.max(0, current + delta);
                buffer.writeUInt32BE(Math.floor(updated / 4294967296), pos + 16 + (i * 8));
                buffer.writeUInt32BE(updated % 4294967296, pos + 20 + (i * 8));
            }
        } else if (['moov', 'mdia', 'minf', 'stbl'].includes(type)) {
            patchAndFreeMp4(buffer.subarray(pos + 8, Math.min(pos + size, buffer.length)), delta, durationMs, globalTimescale);
        }
        pos += size;
    }
}

function parseMoovDuration(buffer) {
    const mvhdIndex = buffer.indexOf('mvhd');
    if (mvhdIndex === -1) return null;
    try {
        const version = buffer.readUInt8(mvhdIndex + 4);
        const timescaleOffset = mvhdIndex + (version === 1 ? 24 : 16);
        const timescale = buffer.readUInt32BE(timescaleOffset);
        
        const duration = version === 1 
            ? (buffer.readUInt32BE(timescaleOffset + 4) * 4294967296 + buffer.readUInt32BE(timescaleOffset + 8))
            : buffer.readUInt32BE(timescaleOffset + 4);
            
        return { durationMs: (duration / timescale) * 1000, timescale };
    } catch (e) { return null; }
}

export function estimateBitrate(contentLength, durationMs, contentType) {
    
    if (contentLength > 0 && durationMs > 0) {
        const bitrateBps = (contentLength * 8 * 1000) / durationMs;
        const bitrateKbps = bitrateBps / 1000;
        return bitrateKbps;
    }

    const defaultBitrates = {
        'audio/mpeg': 192,
        'audio/aac': 128,
        'audio/aacp': 128,
        'audio/flac': 800,
        'audio/ogg': 160,
        'application/ogg': 160,
        'audio/vorbis': 160,
        'audio/opus': 96,
        'audio/mp4': 128, 
        'video/mp4': 128,
        'default': 128
    };

    for (const type in defaultBitrates) {
        if (contentType && contentType.startsWith(type)) {
            return defaultBitrates[type];
        }
    }
    
    return defaultBitrates.default;
}

export async function seekableStream(urlString, startTime, endTime, httpHeaders = {}, customRequestFn = null) {
    
    const meta = { warnings: [] };
    let parsedUrl;
    
    try { 
        parsedUrl = new URL(urlString); 
    } catch (error) { 
        throw new SeekError('INVALID_URL', `Invalid URL: ${urlString}`); 
    }
    
    if (!['http:', 'https:', 'file:'].includes(parsedUrl.protocol)) {
        throw new SeekError('UNSUPPORTED_PROTOCOL', `Unsupported protocol: ${parsedUrl.protocol}. Only http(s) and file:// are supported.`);
    }

    let contentLength = 0;
    let contentType = 'application/octet-stream';
    let acceptRanges = 'none';

    if (parsedUrl.protocol === 'file:') {
        try {
            const stats = await fsPromises.stat(parsedUrl.pathname);
            
            contentLength = stats.size;
            const extension = parsedUrl.pathname.split('.').pop().toLowerCase();
            const mimeTypes = {
                'mp3': 'audio/mpeg',
                'aac': 'audio/aac',
                'flac': 'audio/flac',
                'ogg': 'application/ogg',
                'opus': 'audio/ogg',
                'm4a': 'audio/mp4',
                'mp4': 'audio/mp4'
            };
            contentType = mimeTypes[extension] || 'application/octet-stream';
            acceptRanges = 'bytes';
            
        } catch (error) {
            throw new SeekError('FILE_ACCESS_ERROR', `Error accessing local file: ${parsedUrl.pathname}. ${error.message}`);
        }
    } else {
        try {
            const response = await makeHttpRequest(parsedUrl, { method: 'HEAD', headers: httpHeaders }, customRequestFn);
            
            if (response.statusCode >= 400) {
                 meta.warnings.push(`HEAD error ${response.statusCode}, trying blind probe.`);
            } else {
                contentLength = parseInt(response.headers['content-length'], 10) || 0;
                contentType = response.headers['content-type'] || contentType;
                acceptRanges = response.headers['accept-ranges'] || acceptRanges;
            }
            response.resume(); 

        } catch (error) {
            meta.warnings.push(`Could not retrieve HEAD metadata for ${urlString}. Error: ${error.message}`);
        }
    }

    const PROBE_BYTES = 32 * 1024;
    let probeData = Buffer.alloc(0);

    if (parsedUrl.protocol === 'file:') {
        try {
            const fileHandle = await fsPromises.open(parsedUrl.pathname, 'r');
            const buffer = Buffer.alloc(PROBE_BYTES);
            const { bytesRead } = await fileHandle.read(buffer, 0, PROBE_BYTES, 0);
            probeData = buffer.slice(0, bytesRead);
            await fileHandle.close();
        } catch (error) {
            throw new SeekError('FILE_PROBE_ERROR', `Error probing local file: ${parsedUrl.pathname}. ${error.message}`);
        }
    } else {
        try {
            const probeEnd = contentLength > 0 ? Math.min(contentLength - 1, PROBE_BYTES - 1) : PROBE_BYTES - 1;
            probeData = await fetchWithRange(parsedUrl, 0, probeEnd, httpHeaders, customRequestFn);
        } catch (error) {
            meta.warnings.push(`HTTP probe error: ${error.message}. Continuing without detailed probe.`);
        }
    }

    contentType = detectContentType(probeData, contentType, urlString);
    
    meta.contentType = contentType;
    meta.contentLength = contentLength;
    meta.acceptRanges = acceptRanges;

    let isMp4 = contentType.includes('mp4') || contentType.includes('m4a');
    let mp4Atoms = null;
    
    if (isMp4 && contentLength > 0) {
        try {
            mp4Atoms = await findMp4Headers(parsedUrl, contentLength, httpHeaders, customRequestFn);
            if (mp4Atoms.moov) {
                const parsed = parseMoovDuration(mp4Atoms.moov);
                if (parsed) {
                    meta.durationMs = parsed.durationMs;
                    meta.timescale = parsed.timescale;
                    meta.isMp4Optimized = true;
                    if (!meta.contentType.includes('audio')) meta.contentType = 'audio/mp4';
                }
            }
        } catch (error) {
            meta.warnings.push(`MP4 optimization failed: ${error.message}`);
        }
    }

    if (probeData.length > 0) {
        let isWebm = false;
        if (probeData.length >= 4 && probeData.readUInt32BE(0) === 0x1A45DFA3) {
            try {
                const decoder = new Decoder();
                const elms = decoder.decode(probeData);

                const durationEl = elms.find(e => e.name === 'Duration');
                const timecodeScaleEl = elms.find(e => e.name === 'TimecodeScale');
                const codecIdEl = elms.find(e => e.name === 'CodecID');

                if (durationEl && durationEl.type !== 'm') {
                    isWebm = true;
                    const duration = durationEl.value;
                    const timecodeScale = (timecodeScaleEl && timecodeScaleEl.type !== 'm') ? timecodeScaleEl.value : 1000000;
                    const codecId = (codecIdEl && codecIdEl.type !== 'm') ? codecIdEl.value : null;
                    
                    meta.durationMs = duration * (timecodeScale / 1000000);

                    let container = 'webm';
                    let mime = 'audio/webm';
                    if (codecId === 'A_OPUS') {
                        mime = 'audio/opus';
                    } else if (codecId === 'A_VORBIS') {
                        mime = 'audio/vorbis';
                    } else if (codecId) {
                        mime = `audio/webm; codecs=${codecId.toLowerCase()}`;
                    }
                    
                    meta.contentType = mime;
                    meta.codec = {
                        container,
                        mime,
                        codecName: codecId,
                    };
                }
            } catch (error) {
                meta.warnings.push(`Error parsing probeData with ts-ebml: ${error.message}. Attempting CodecParser.`);
            }
        }

        if (!isWebm && !isMp4) {
            try {
                const parser = new CodecParser(contentType);
                const parsedFrames = parser.parseAll(probeData);

                if (parsedFrames.length > 0 && parser.codec) {
                    meta.codec = {
                        container: parser.codec === 'mpeg' ? 'mp3' : parser.codec,
                        mime: meta.contentType,
                        codecName: parser.codec
                    };
                    if (meta.contentType.startsWith('application/ogg')) {
                        meta.contentType = `audio/${parser.codec}`;
                        meta.codec.mime = meta.contentType;
                    }
                } else {
                    meta.codec = undefined;
                }
            } catch (error) {
                meta.warnings.push(`Error parsing probeData with codec-parser: ${error.message}`);
            }
        }
    }

    let startByte = 0;
    let endByte = contentLength > 0 ? contentLength - 1 : Infinity;
    let effectiveDurationMs = meta.durationMs;
    
    if (!effectiveDurationMs && meta.contentLength > 0) {
        const estimatedBitrateKbps = estimateBitrate(meta.contentLength, 0, meta.contentType);
        effectiveDurationMs = (meta.contentLength * 8) / (estimatedBitrateKbps * 1000) * 1000;
    }

    if (effectiveDurationMs > 0 && !meta.durationMs) {
        meta.durationMs = effectiveDurationMs;
    }

    if (acceptRanges === 'bytes' && contentLength > 0 && effectiveDurationMs > 0) {
        if (typeof startTime === 'number' && startTime > 0) {
            startByte = Math.floor((startTime / effectiveDurationMs) * contentLength);
        } else {
            startByte = 0;
        }

        if (typeof endTime === 'number' && endTime > 0) {
            endByte = Math.min(contentLength - 1, Math.floor((endTime / effectiveDurationMs) * contentLength));
        } else {
            endByte = contentLength > 0 ? contentLength - 1 : Infinity;
        }

        if (startByte > endByte && endByte !== Infinity) {
            endByte = contentLength > 0 ? contentLength - 1 : Infinity;
        }
    } else if (startTime !== undefined || (endTime !== undefined && endTime !== null)) {
        meta.warnings.push('Server does not support byte ranges or unknown Content-Length. Full streaming will be attempted, ignoring startTime/endTime.');
    }

    meta.resolvedRange = { start: startByte, end: endByte };

    if (isMp4 && startByte > 0 && mp4Atoms && mp4Atoms.moov) {
        const { PassThrough } = await import('stream');
        const finalStream = new PassThrough();

        const pipeMp4 = async () => {
            try {
                let alignedStartByte = startByte;
                if (startTime > 0) {
                    const timeOffset = getMp4AudioSampleOffsetByTime(mp4Atoms.moov, startTime);
                    if (timeOffset !== null) {
                        alignedStartByte = timeOffset;
                    }
                } else {
                    const audioSamples = getMp4AudioSamples(mp4Atoms.moov);
                    if (audioSamples.length > 0) {
                        const closestSample = audioSamples.find(s => s.offset >= startByte) || audioSamples[audioSamples.length - 1];
                        const prevSample = audioSamples.find(s => s.offset <= startByte && (s.offset + s.size) > startByte);
                        if (prevSample) alignedStartByte = prevSample.offset;
                        else if (closestSample) alignedStartByte = closestSample.offset;
                    }
                }

                const headerSize = (mp4Atoms.ftyp ? mp4Atoms.ftyp.length : 0) + mp4Atoms.moov.length + 8;
                const delta = headerSize - alignedStartByte;
                
                const clipDurationMs = (endTime && endTime !== Infinity ? endTime : meta.durationMs) - (startTime || 0);
                const globalTimescale = meta.timescale || 1000;
                patchAndFreeMp4(mp4Atoms.moov, delta, clipDurationMs, globalTimescale);

                if (mp4Atoms.ftyp) finalStream.write(mp4Atoms.ftyp);
                finalStream.write(mp4Atoms.moov);
                
                const mdatHeader = Buffer.alloc(8);
                mdatHeader.writeUInt32BE(0, 0); 
                mdatHeader.write('mdat', 4);
                finalStream.write(mdatHeader);

                const dataStream = createHttpStream(parsedUrl, alignedStartByte, endByte, httpHeaders, customRequestFn);
                dataStream.pipe(finalStream);
            } catch (err) {
                finalStream.emit('error', err);
            }
        };

        pipeMp4();

        meta.mp4HeaderPrepended = true;
        meta.originalSeekRange = { start: startByte, end: endByte };
        meta.resolvedRange = { start: 0, end: Infinity }; 
        return { stream: finalStream, meta };
    }

    if (meta.codec && meta.codec.container === 'webm' && startByte > 0) {
        const { PassThrough } = await import('stream');
        const finalStream = new PassThrough();

        const pipeMedia = async () => {
            try {
                let headerEndOffset = null;
                try {
                    const decoder = new Decoder();
                    const elms = decoder.decode(probeData);
                    const clusterEl = elms.find(e => e.name === 'Cluster');
                    headerEndOffset = clusterEl ? clusterEl.tagStart : null;
                } catch (e) {
                }

                if (headerEndOffset === null) {
                    const rawStream = createHttpStream(parsedUrl, startByte, endByte, httpHeaders, customRequestFn);
                    rawStream.pipe(finalStream);
                    return;
                }
                
                const headerStream = createHttpStream(parsedUrl, 0, headerEndOffset - 1, httpHeaders, customRequestFn);
                for await (const chunk of headerStream) {
                    finalStream.write(chunk);
                }

                const fragmentStream = createHttpStream(parsedUrl, startByte, endByte, httpHeaders, customRequestFn);
                const magicCluster = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
                let foundCluster = false;
                let remainder = Buffer.alloc(0);


                for await (const chunk of fragmentStream) {
                    if (foundCluster) {
                        finalStream.write(chunk);
                        continue;
                    }

                    const buffer = Buffer.concat([remainder, chunk]);
                    const index = buffer.indexOf(magicCluster);

                    if (index !== -1) {
                        foundCluster = true;
                        const validChunk = buffer.slice(index);
                        finalStream.write(validChunk);
                    } else {
                        remainder = buffer.slice(Math.max(0, buffer.length - magicCluster.length + 1));
                    }
                }

                finalStream.end();

            } catch (err) {
                finalStream.emit('error', err);
            }
        };

        pipeMedia();

        const fragmentLength = (endByte === Infinity || contentLength === 0) ? Infinity : (endByte - startByte + 1);
        let tempHeaderEndOffset = null;
        try {
            const decoder = new Decoder();
            const elms = decoder.decode(probeData);
            const clusterEl = elms.find(e => e.name === 'Cluster');
            tempHeaderEndOffset = clusterEl ? clusterEl.tagStart : null;
        } catch(e) {}

        if (tempHeaderEndOffset) {
            meta.contentLength = fragmentLength === Infinity ? undefined : tempHeaderEndOffset + fragmentLength;
        }
        meta.resolvedRange = { start: 0, end: meta.contentLength ? meta.contentLength - 1 : Infinity };
        meta.webmHeaderPrepended = true;
        meta.originalSeekRange = { start: startByte, end: endByte };
        
        return { stream: finalStream, meta };
    }

    let stream;
    if (parsedUrl.protocol === 'file:') {
        stream = createLocalFileStream(parsedUrl.pathname, meta.resolvedRange.start, meta.resolvedRange.end);
    } else {
        stream = createHttpStream(parsedUrl, meta.resolvedRange.start, meta.resolvedRange.end, httpHeaders, customRequestFn);
    }

    return { stream, meta };
}