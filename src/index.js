import { Readable } from 'stream';
import { URL } from 'url';
import http from 'http';
import https from 'https';
import fs from 'fs/promises';
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

    const allChunks = [];
    let currentPos = start;

    while (true) {
        
        const isInfinite = (end === Infinity);
        const chunkEnd = isInfinite ? currentPos + chunkSize - 1 : Math.min(currentPos + chunkSize - 1, end);

        if (!isInfinite && currentPos > chunkEnd) {
            break;
        }

        const rangeHeader = `bytes=${currentPos}-${chunkEnd}`;
        const headers = { ...customHeaders, 'Range': rangeHeader };

        const response = await makeHttpRequest(url, { headers }, customRequestFn);

        if (response.statusCode === 416) {
            break;
        }
        
        if (response.statusCode !== 206) {
            if (response.statusCode === 200 && start === 0) {
                for await (const chunk of response) {
                    allChunks.push(chunk);
                }
                break;
            }
            throw new SeekError('UNEXPECTED_HTTP_STATUS', `Unexpected status for chunk ${rangeHeader}: ${response.statusCode}`);
        }

        let hasData = false;
        for await (const chunk of response) {
            allChunks.push(chunk);
            hasData = true;
        }

        if (!hasData) {
            break;
        }

        currentPos = chunkEnd + 1;
        
        if (!isInfinite && currentPos > end) {
            break;
        }
    }
    
    const finalBuffer = Buffer.concat(allChunks);
    return finalBuffer;
}

function createLocalFileStream(filePath, start, end) {
    const stream = fs.createReadStream(filePath, { start, end });
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
            throw new SeekError('UNEXPECTED_HTTP_STATUS', `Unexpected status for chunk: ${response.statusCode}`);
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
        'default': 128
    };

    for (const type in defaultBitrates) {
        if (contentType.startsWith(type)) {
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
            const stats = await fs.stat(parsedUrl.pathname);
            
            contentLength = stats.size;
            const extension = parsedUrl.pathname.split('.').pop().toLowerCase();
            const mimeTypes = {
                'mp3': 'audio/mpeg',
                'aac': 'audio/aac',
                'flac': 'audio/flac',
                'ogg': 'application/ogg',
                'opus': 'audio/ogg'
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
                throw new SeekError('HTTP_HEAD_ERROR', `Error making HEAD request to ${urlString}: ${response.statusCode} ${response.statusMessage}`);
            }
            
            contentLength = parseInt(response.headers['content-length'], 10) || 0;
            contentType = response.headers['content-type'] || contentType;
            acceptRanges = response.headers['accept-ranges'] || acceptRanges;

            if (contentType.includes('application/octet-stream')) {
                const extension = parsedUrl.pathname.split('.').pop().toLowerCase();
                const mimeTypes = {
                    'mp3': 'audio/mpeg',
                    'aac': 'audio/aac',
                    'flac': 'audio/flac',
                    'ogg': 'application/ogg',
                    'opus': 'audio/opus',
                    'webm': 'audio/webm'
                };
                contentType = mimeTypes[extension] || contentType;

                if (contentType === 'application/octet-stream' && extension === 'webm') {
                    contentType = 'audio/webm';
                }
            }
        } catch (error) {
            meta.warnings.push(`Could not retrieve HEAD metadata for ${urlString}. Error: ${error.message}`);
        }
    }

    meta.contentType = contentType;
    meta.contentLength = contentLength;
    meta.acceptRanges = acceptRanges;

    const PROBE_BYTES = 32 * 1024;
    let probeData = Buffer.alloc(0);

    if (parsedUrl.protocol === 'file:') {
        try {
            const fileHandle = await fs.open(parsedUrl.pathname, 'r');
            const buffer = Buffer.alloc(PROBE_BYTES);
            const { bytesRead } = await fileHandle.read(buffer, 0, PROBE_BYTES, 0);
            probeData = buffer.slice(0, bytesRead);
            await fileHandle.close();
        } catch (error) {
            throw new SeekError('FILE_PROBE_ERROR', `Error probing local file: ${parsedUrl.pathname}. ${error.message}`);
        }
    } else if (contentLength > 0 && acceptRanges === 'bytes') {
        try {
            probeData = await fetchWithRange(parsedUrl, 0, Math.min(contentLength - 1, PROBE_BYTES - 1), httpHeaders, customRequestFn);
        } catch (error) {
            meta.warnings.push(`HTTP probe error: ${error.message}. Continuing without detailed probe.`);
        }
    } else {
        meta.warnings.push('Initial probe failed: Unknown Content-Length or byte ranges not supported.');
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
                } else {
                }
            } catch (error) {
                meta.warnings.push(`Error parsing probeData with ts-ebml: ${error.message}. Attempting CodecParser.`);
            }
        } else {
        }

        if (!isWebm) {
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
                    throw new SeekError('WEBM_HEADER_PARSE_ERROR', `Could not find the end of the WebM header (Cluster) in the initial ${probeData.length} probe bytes.`);
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