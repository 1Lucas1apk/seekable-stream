import { Readable } from 'stream';
import { URL } from 'url';
import http from 'http';
import https from 'https';
import fsPromises from 'fs/promises';
import { createReadStream } from 'fs';
import CodecParser from 'codec-parser';
import { Decoder } from 'ts-ebml';

// WebM seek metadata is immutable for a given media URL. Reuse the parsed
// header, Cues index and header prefix across repeated seeks in the same node.
const WEBM_SEEK_CACHE = new Map();
const WEBM_HEAD_INFLIGHT = new Map();
const WEBM_PROBE_INFLIGHT = new Map();
const WEBM_CUE_INDEX_INFLIGHT = new Map();
const WEBM_HEADER_PREFIX_INFLIGHT = new Map();
const WEBM_SEEK_CACHE_TTL_MS = 5 * 60 * 1000;
const WEBM_SEEK_CACHE_MAX_ENTRIES = 32;
const WEBM_HEADER_PREFIX_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const WEBM_SEEK_PREWARM_TAIL_BYTES = 512 * 1024;
const WEBM_SEEK_PREWARM_ENABLED = process.env.NODELINK_WEBM_SEEK_PREWARM !== 'false';

function getOrCreateSharedPromise(map, key, loader) {
    const existing = map.get(key);
    if (existing) return existing;

    const promise = Promise.resolve().then(loader);
    map.set(key, promise);
    const cleanup = () => {
        if (map.get(key) === promise) map.delete(key);
    };
    promise.then(cleanup, cleanup);
    return promise;
}

function createWebmSeekCacheKey(url, headers = {}) {
    const normalizedHeaders = Object.entries(headers || {})
        .filter(([name]) => name.toLowerCase() !== 'range')
        .map(([name, value]) => [name.toLowerCase(), String(value)])
        .sort(([a], [b]) => a.localeCompare(b));
    return `${url.toString()}\\n${JSON.stringify(normalizedHeaders)}`;
}

function getWebmSeekCache(key) {
    if (!key) return null;
    const entry = WEBM_SEEK_CACHE.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        WEBM_SEEK_CACHE.delete(key);
        return null;
    }
    WEBM_SEEK_CACHE.delete(key);
    entry.expiresAt = Date.now() + WEBM_SEEK_CACHE_TTL_MS;
    WEBM_SEEK_CACHE.set(key, entry);
    return entry;
}

function setWebmSeekCache(key, entry) {
    if (!key || !entry) return entry;
    entry.expiresAt = Date.now() + WEBM_SEEK_CACHE_TTL_MS;
    WEBM_SEEK_CACHE.delete(key);
    WEBM_SEEK_CACHE.set(key, entry);
    while (WEBM_SEEK_CACHE.size > WEBM_SEEK_CACHE_MAX_ENTRIES) {
        const oldestKey = WEBM_SEEK_CACHE.keys().next().value;
        if (oldestKey === undefined) break;
        WEBM_SEEK_CACHE.delete(oldestKey);
    }
    return entry;
}

async function getWebmHeaderPrefix(parsedUrl, headerEndOffset, customHeaders, customRequestFn, cacheEntry, cacheKey) {
    if (cacheEntry?.prefixBuffer) return cacheEntry.prefixBuffer;
    if (headerEndOffset <= 0 || headerEndOffset > WEBM_HEADER_PREFIX_CACHE_MAX_BYTES) return null;

    if (cacheEntry?.prefixPromise) return cacheEntry.prefixPromise;

    const request = getOrCreateSharedPromise(
        WEBM_HEADER_PREFIX_INFLIGHT,
        cacheKey || parsedUrl.toString(),
        () => fetchWithRange(
            parsedUrl,
            0,
            headerEndOffset - 1,
            customHeaders,
            customRequestFn
        )
    ).then((buffer) => {
        if (buffer.length !== headerEndOffset) {
            throw new SeekError(
                'INCOMPLETE_WEBM_HEADER',
                `WebM header prefix returned ${buffer.length} bytes; expected ${headerEndOffset}`
            );
        }
        if (cacheEntry) cacheEntry.prefixBuffer = buffer;
        return buffer;
    }).catch((error) => {
        if (cacheEntry) cacheEntry.prefixPromise = null;
        throw error;
    }).finally(() => {
        if (cacheEntry) cacheEntry.prefixPromise = null;
    });

    if (cacheEntry) cacheEntry.prefixPromise = request;
    return request;
}

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

async function fetchWithRange(url, start, end, customHeaders = {}, customRequestFn = null) {
    if (start < 0 || (end !== Infinity && end < start)) {
        return Buffer.alloc(0);
    }

    const headers = { ...customHeaders, Range: `bytes=${start}-${end}` };
    const response = await makeHttpRequest(url, { headers }, customRequestFn);
    const statusCode = response.statusCode;

    if (statusCode === 416) {
        response.resume();
        return Buffer.alloc(0);
    }

    if (statusCode !== 206 && statusCode !== 200) {
        response.resume();
        throw new SeekError(
            'UNEXPECTED_HTTP_STATUS',
            `Unexpected status: ${statusCode}`
        );
    }

    let expectedLength = Infinity;
    if (statusCode === 206) {
        const contentRange = String(
            response.headers?.['content-range'] ?? response.headers?.['Content-Range'] ?? ''
        );
        const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange);
        if (!match) {
            response.resume();
            throw new SeekError('INVALID_CONTENT_RANGE', 'Missing or invalid Content-Range header');
        }

        const rangeStart = Number(match[1]);
        const rangeEnd = Number(match[2]);
        if (
            rangeStart !== start ||
            !Number.isSafeInteger(rangeEnd) ||
            rangeEnd < rangeStart ||
            (end !== Infinity && rangeEnd > end)
        ) {
            response.resume();
            throw new SeekError(
                'INVALID_CONTENT_RANGE',
                `Unexpected Content-Range: ${contentRange}; requested ${start}-${end}`
            );
        }

        expectedLength = rangeEnd - rangeStart + 1;
        const contentLength = Number(response.headers?.['content-length']);
        if (Number.isFinite(contentLength) && contentLength !== expectedLength) {
            response.resume();
            throw new SeekError('INVALID_CONTENT_LENGTH', 'Content-Length does not match Content-Range');
        }
    } else {
        if (start !== 0) {
            response.resume();
            throw new SeekError(
                'RANGE_NOT_SUPPORTED',
                'The server ignored a non-zero HTTP Range request'
            );
        }
        expectedLength = end === Infinity ? Infinity : end + 1;
    }

    const allChunks = [];
    let bytesRead = 0;
    try {
        for await (const chunkValue of response) {
            const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
            const remaining = expectedLength - bytesRead;
            if (remaining <= 0) break;

            if (Number.isFinite(remaining) && chunk.length > remaining) {
                allChunks.push(chunk.subarray(0, remaining));
                bytesRead += remaining;
                break;
            }

            allChunks.push(chunk);
            bytesRead += chunk.length;
        }
    } finally {
        if (statusCode === 200 || (Number.isFinite(expectedLength) && bytesRead >= expectedLength)) {
            response.destroy();
        }
    }

    if (
        statusCode === 206 &&
        Number.isFinite(expectedLength) &&
        bytesRead !== expectedLength
    ) {
        throw new SeekError(
            'INCOMPLETE_RANGE',
            `HTTP Range returned ${bytesRead} bytes; expected ${expectedLength}`
        );
    }

    return Buffer.concat(allChunks, bytesRead);
}

function createLocalFileStream(filePath, start, end) {
    const stream = createReadStream(filePath, { start, end });
    return stream;
}

const RANGE_RETRYABLE_CODES = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'EPIPE',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ECONNREFUSED'
]);
const MAX_RANGE_STREAM_RETRIES = 3;

function getErrorCode(error) {
    return String(error?.code ?? error?.cause?.code ?? '');
}

function isRetryableRangeError(error) {
    if (!error || error.name === 'AbortError' || getErrorCode(error) === 'ABORT_ERR') {
        return false;
    }
    return RANGE_RETRYABLE_CODES.has(getErrorCode(error));
}

function waitForRangeRetry(attempt) {
    const delay = Math.min(200 * 2 ** (attempt - 1), 2000);
    return new Promise((resolve) => setTimeout(resolve, delay));
}

function createRangeStreamError(error, start, end, received, expected) {
    const code = getErrorCode(error);
    const detail = error?.message || error?.cause?.message || String(error || 'Unknown stream error');
    const suffix = code ? ` (${code})` : '';
    const wrapped = new SeekError(
        'RANGE_STREAM_INTERRUPTED',
        `HTTP Range ${start}-${end} interrupted after ${received}/${expected} bytes${suffix}: ${detail}`
    );
    wrapped.cause = error;
    return wrapped;
}

async function* generateHttpChunks(parsedUrl, start, end, customHeaders, customRequestFn, chunkSize) {
    let currentPos = start;
    let knownTotal = null;

    while (currentPos <= end || end === Infinity) {
        const chunkEnd = end === Infinity
            ? currentPos + chunkSize - 1
            : Math.min(currentPos + chunkSize - 1, end);

        if (currentPos > chunkEnd) break;

        let retries = 0;
        let chunkCompleted = false;

        while (!chunkCompleted) {
            const requestStart = currentPos;
            const headers = {
                ...customHeaders,
                Range: `bytes=${requestStart}-${chunkEnd}`
            };

            let response;
            try {
                response = await makeHttpRequest(parsedUrl, { headers }, customRequestFn);
            } catch (error) {
                if (isRetryableRangeError(error) && retries < MAX_RANGE_STREAM_RETRIES) {
                    retries++;
                    await waitForRangeRetry(retries);
                    continue;
                }
                throw createRangeStreamError(error, requestStart, chunkEnd, 0, chunkEnd - requestStart + 1);
            }

            if (response.statusCode === 416) {
                const contentRange = String(
                    response.headers?.['content-range'] ?? response.headers?.['Content-Range'] ?? ''
                );
                response.resume();
                const unsatisfied = /^bytes \*\/(\d+)$/i.exec(contentRange);
                const total = unsatisfied ? Number(unsatisfied[1]) : null;
                if (total !== null && requestStart >= total) return;
                throw new SeekError(
                    'RANGE_NOT_SATISFIABLE',
                    `HTTP Range ${requestStart}-${chunkEnd} was rejected before EOF`
                );
            }

            if (response.statusCode === 200) {
                if (requestStart !== 0) {
                    response.resume();
                    throw new SeekError(
                        'RANGE_NOT_SUPPORTED',
                        'The server ignored a non-zero HTTP Range request'
                    );
                }

                // A 200 response means the origin ignored Range. Do not retry
                // after yielding bytes, because restarting would duplicate data.
                let bytesRead = 0;
                const maxBytes = end === Infinity ? Infinity : end + 1;
                try {
                    for await (const chunkValue of response) {
                        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
                        const remaining = maxBytes - bytesRead;
                        if (remaining <= 0) break;
                        const output = Number.isFinite(remaining)
                            ? chunk.subarray(0, remaining)
                            : chunk;
                        if (output.length) yield output;
                        bytesRead += output.length;
                        if (output.length !== chunk.length || bytesRead >= maxBytes) break;
                    }
                } catch (error) {
                    response.destroy?.();
                    throw createRangeStreamError(error, 0, end, bytesRead, maxBytes);
                } finally {
                    response.destroy?.();
                }

                if (response.complete === false && bytesRead < maxBytes) {
                    throw new SeekError(
                        'INCOMPLETE_RESPONSE',
                        `Full-response fallback was interrupted after ${bytesRead} bytes`
                    );
                }
                return;
            }

            if (response.statusCode !== 206) {
                response.resume();
                throw new SeekError(
                    'UNEXPECTED_HTTP_STATUS',
                    `Unexpected status: ${response.statusCode}`
                );
            }

            const contentRange = String(
                response.headers?.['content-range'] ?? response.headers?.['Content-Range'] ?? ''
            );
            const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange);
            if (!match) {
                response.resume();
                throw new SeekError('INVALID_CONTENT_RANGE', 'Missing or invalid Content-Range header');
            }

            const rangeStart = Number(match[1]);
            const rangeEnd = Number(match[2]);
            const total = match[3] === '*' ? null : Number(match[3]);
            if (
                rangeStart !== requestStart ||
                !Number.isSafeInteger(rangeEnd) ||
                rangeEnd < rangeStart ||
                rangeEnd > chunkEnd ||
                (total !== null && (!Number.isSafeInteger(total) || total <= rangeEnd))
            ) {
                response.resume();
                throw new SeekError(
                    'INVALID_CONTENT_RANGE',
                    `Unexpected Content-Range: ${contentRange}; requested ${requestStart}-${chunkEnd}`
                );
            }
            if (knownTotal !== null && total !== null && knownTotal !== total) {
                response.resume();
                throw new SeekError('RESOURCE_CHANGED', 'HTTP resource size changed during streaming');
            }
            if (total !== null) knownTotal = total;

            const expectedBytes = rangeEnd - rangeStart + 1;
            const contentLength = Number(response.headers?.['content-length']);
            if (Number.isFinite(contentLength) && contentLength !== expectedBytes) {
                response.resume();
                throw new SeekError('INVALID_CONTENT_LENGTH', 'Content-Length does not match Content-Range');
            }

            let bytesRead = 0;
            try {
                for await (const chunkValue of response) {
                    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
                    if (bytesRead + chunk.length > expectedBytes) {
                        const remaining = expectedBytes - bytesRead;
                        if (remaining > 0) {
                            yield chunk.subarray(0, remaining);
                            bytesRead += remaining;
                        }
                        throw new SeekError('OVERSIZED_RANGE', 'HTTP Range response exceeded Content-Range');
                    }
                    if (chunk.length) yield chunk;
                    bytesRead += chunk.length;
                }
            } catch (error) {
                response.destroy?.();

                if (error?.code === 'OVERSIZED_RANGE') {
                    throw error;
                }

                // The bytes already yielded are valid. Resume at the first byte
                // not delivered, so a retry cannot duplicate or skip media data.
                if (bytesRead === expectedBytes) {
                    currentPos = rangeEnd + 1;
                    retries = 0;
                    chunkCompleted = currentPos > chunkEnd;
                    continue;
                }

                currentPos = requestStart + bytesRead;
                if (isRetryableRangeError(error) && retries < MAX_RANGE_STREAM_RETRIES) {
                    retries++;
                    await waitForRangeRetry(retries);
                    continue;
                }
                throw createRangeStreamError(error, requestStart, rangeEnd, bytesRead, expectedBytes);
            }

            if (bytesRead !== expectedBytes) {
                currentPos = requestStart + bytesRead;
                const incomplete = new SeekError(
                    'INCOMPLETE_RANGE',
                    `HTTP Range returned ${bytesRead} bytes; expected ${expectedBytes}`
                );
                if (retries < MAX_RANGE_STREAM_RETRIES) {
                    retries++;
                    await waitForRangeRetry(retries);
                    continue;
                }
                throw incomplete;
            }

            currentPos = rangeEnd + 1;
            retries = 0;
            chunkCompleted = currentPos > chunkEnd;
            if (knownTotal !== null && currentPos >= knownTotal) return;
            if (end !== Infinity && currentPos > end) return;
        }
    }
}

function createHttpStream(parsedUrl, start, end, customHeaders = {}, customRequestFn = null, chunkSize = 256 * 1024) {
    return Readable.from(generateHttpChunks(parsedUrl, start, end, customHeaders, customRequestFn, chunkSize));
}

const readEbmlVint = (buffer, offset, removeMarker = true) => {
    if (offset < 0 || offset >= buffer.length) return null;
    const first = buffer[offset];
    if (!first) return null;

    let mask = 0x80;
    let length = 1;
    while (length <= 8 && (first & mask) === 0) {
        mask >>= 1;
        length++;
    }
    if (length > 8 || offset + length > buffer.length) return null;

    let value = BigInt(first);
    for (let index = 1; index < length; index++) {
        value = (value << 8n) | BigInt(buffer[offset + index]);
    }
    if (removeMarker) {
        value &= (1n << BigInt(7 * length)) - 1n;
    }
    return { value, length };
};

const readEbmlElement = (buffer, offset) => {
    const id = readEbmlVint(buffer, offset, false);
    if (!id) return null;
    const size = readEbmlVint(buffer, offset + id.length, true);
    if (!size) return null;

    const sizeLength = size.length;
    const dataStart = offset + id.length + sizeLength;
    const unknownSize = size.value === (1n << BigInt(7 * sizeLength)) - 1n;
    if (unknownSize) {
        return {
            id: buffer.subarray(offset, offset + id.length).toString('hex'),
            start: offset,
            dataStart,
            dataEnd: buffer.length,
            nextOffset: buffer.length,
            unknownSize: true
        };
    }
    if (size.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;

    const dataEnd = dataStart + Number(size.value);
    return {
        id: buffer.subarray(offset, offset + id.length).toString('hex'),
        start: offset,
        dataStart,
        dataEnd,
        nextOffset: dataEnd,
        unknownSize: false
    };
};

const readEbmlUint = (buffer, start, end) => {
    let value = 0n;
    for (let index = start; index < end; index++) {
        value = (value << 8n) | BigInt(buffer[index]);
    }
    return value;
};

const getWebmHeaderInfo = (probeData) => {
    const ebmlHeader = readEbmlElement(probeData, 0);
    if (!ebmlHeader || ebmlHeader.id !== '1a45dfa3') return null;

    const segment = readEbmlElement(probeData, ebmlHeader.nextOffset);
    if (!segment || segment.id !== '18538067') return null;

    const info = {
        segmentDataOffset: segment.dataStart,
        firstClusterOffset: null,
        timecodeScaleNs: 1000000n,
        durationMs: null,
        audioDurationMs: null,
        audioTrackNumber: null,
        codecId: null,
        codecDelayNs: 0n,
        seekPreRollNs: 80000000n
    };

    const segmentEnd = Math.min(probeData.length, segment.dataEnd);
    for (let offset = segment.dataStart; offset < segmentEnd;) {
        const element = readEbmlElement(probeData, offset);
        if (!element) break;

        if (element.id === '1f43b675') {
            info.firstClusterOffset = element.start;
            break;
        }

        if (element.id === '1549a966') {
            const infoEnd = Math.min(element.dataEnd, segmentEnd);
            let durationTicks = null;
            for (let childOffset = element.dataStart; childOffset < infoEnd;) {
                const child = readEbmlElement(probeData, childOffset);
                if (!child) break;
                if (child.id === '2ad7b1') {
                    info.timecodeScaleNs = readEbmlUint(probeData, child.dataStart, Math.min(child.dataEnd, probeData.length));
                } else if (child.id === '4489') {
                    const durationBytes = child.dataEnd - child.dataStart;
                    let parsedDurationTicks = NaN;
                    if (durationBytes === 4) {
                        parsedDurationTicks = probeData.readFloatBE(child.dataStart);
                    } else if (durationBytes === 8) {
                        parsedDurationTicks = probeData.readDoubleBE(child.dataStart);
                    }
                    if (Number.isFinite(parsedDurationTicks) && parsedDurationTicks > 0) {
                        durationTicks = parsedDurationTicks;
                    }
                }
                if (child.nextOffset <= childOffset || child.unknownSize) break;
                childOffset = child.nextOffset;
            }
            if (durationTicks !== null) {
                info.durationMs = durationTicks * Number(info.timecodeScaleNs) / 1_000_000;
            }
        } else if (element.id === '1654ae6b') {
            const tracksEnd = Math.min(element.dataEnd, segmentEnd);
            let fallbackAudioTrack = null;
            for (let trackOffset = element.dataStart; trackOffset < tracksEnd;) {
                const trackEntry = readEbmlElement(probeData, trackOffset);
                if (!trackEntry) break;
                if (trackEntry.id === 'ae') {
                    const entryEnd = Math.min(trackEntry.dataEnd, tracksEnd);
                    let trackNumber = null;
                    let trackType = null;
                    let codecId = null;
                    let codecDelayNs = null;
                    let seekPreRollNs = null;
                    for (let fieldOffset = trackEntry.dataStart; fieldOffset < entryEnd;) {
                        const field = readEbmlElement(probeData, fieldOffset);
                        if (!field) break;
                        const fieldEnd = Math.min(field.dataEnd, probeData.length);
                        if (field.id === 'd7') trackNumber = Number(readEbmlUint(probeData, field.dataStart, fieldEnd));
                        else if (field.id === '83') trackType = Number(readEbmlUint(probeData, field.dataStart, fieldEnd));
                        else if (field.id === '86') codecId = probeData.subarray(field.dataStart, fieldEnd).toString('utf8');
                        else if (field.id === '56aa') codecDelayNs = readEbmlUint(probeData, field.dataStart, fieldEnd);
                        else if (field.id === '56bb') seekPreRollNs = readEbmlUint(probeData, field.dataStart, fieldEnd);
                        if (field.nextOffset <= fieldOffset || field.unknownSize) break;
                        fieldOffset = field.nextOffset;
                    }
                    if (trackType === 2 && Number.isSafeInteger(trackNumber)) {
                        const candidate = {
                            trackNumber,
                            codecId,
                            codecDelayNs: codecDelayNs ?? 0n,
                            seekPreRollNs: seekPreRollNs ?? 80000000n
                        };
                        if (fallbackAudioTrack === null) fallbackAudioTrack = candidate;
                        if (codecId === 'A_OPUS') {
                            fallbackAudioTrack = candidate;
                            break;
                        }
                    }
                }
                if (trackEntry.nextOffset <= trackOffset || trackEntry.unknownSize) break;
                trackOffset = trackEntry.nextOffset;
            }
            if (fallbackAudioTrack) {
                info.audioTrackNumber = fallbackAudioTrack.trackNumber;
                info.codecId = fallbackAudioTrack.codecId;
                info.codecDelayNs = fallbackAudioTrack.codecDelayNs;
                info.seekPreRollNs = fallbackAudioTrack.seekPreRollNs;
            }
        }

        if (element.nextOffset <= offset || element.unknownSize) break;
        offset = element.nextOffset;
    }

    return info;
};

const parseWebmCues = (buffer) => {
    const cuesId = Buffer.from([0x1c, 0x53, 0xbb, 0x6b]);
    const cuePoints = [];
    let searchFrom = buffer.length;

    while (searchFrom > 0) {
        const cueOffset = buffer.lastIndexOf(cuesId, searchFrom - 1);
        if (cueOffset < 0) break;
        const cues = readEbmlElement(buffer, cueOffset);
        if (cues && cues.id === '1c53bb6b' && !cues.unknownSize && cues.dataEnd <= buffer.length) {
            for (let pointOffset = cues.dataStart; pointOffset < cues.dataEnd;) {
                const point = readEbmlElement(buffer, pointOffset);
                if (!point) break;
                if (point.id === 'bb') {
                    let cueTime = null;
                    const positions = [];
                    for (let childOffset = point.dataStart; childOffset < point.dataEnd;) {
                        const child = readEbmlElement(buffer, childOffset);
                        if (!child) break;
                        if (child.id === 'b3') {
                            cueTime = readEbmlUint(buffer, child.dataStart, child.dataEnd);
                        } else if (child.id === 'b7') {
                            let cueTrack = null;
                            let clusterPosition = null;
                            for (let positionOffset = child.dataStart; positionOffset < child.dataEnd;) {
                                const field = readEbmlElement(buffer, positionOffset);
                                if (!field) break;
                                if (field.id === 'f7') cueTrack = Number(readEbmlUint(buffer, field.dataStart, field.dataEnd));
                                else if (field.id === 'f1') clusterPosition = readEbmlUint(buffer, field.dataStart, field.dataEnd);
                                if (field.nextOffset <= positionOffset || field.unknownSize) break;
                                positionOffset = field.nextOffset;
                            }
                            if (clusterPosition !== null) positions.push({ cueTrack, clusterPosition });
                        }
                        if (child.nextOffset <= childOffset || child.unknownSize) break;
                        childOffset = child.nextOffset;
                    }
                    if (cueTime !== null) {
                        for (const position of positions) cuePoints.push({ cueTime, ...position });
                    }
                }
                if (point.nextOffset <= pointOffset || point.unknownSize) break;
                pointOffset = point.nextOffset;
            }
            if (cuePoints.length) return cuePoints;
        }
        searchFrom = cueOffset;
    }

    return cuePoints;
};

const readBlockVint = (buffer, offset) => {
    const value = readEbmlVint(buffer, offset, true);
    if (!value || value.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { value: Number(value.value), length: value.length };
};

const parseOpusBlockPackets = (data) => {
    const track = readBlockVint(data, 0);
    if (!track || track.length + 3 > data.length) return null;
    let offset = track.length;
    const relativeTimecode = data.readInt16BE(offset);
    offset += 2;
    const flags = data[offset++];
    const lacing = (flags >> 1) & 0x03;
    if (lacing === 0) return { trackNumber: track.value, relativeTimecode, packets: [data.subarray(offset)] };
    if (offset >= data.length) return null;

    const frameCount = (data[offset++] ?? 0) + 1;
    if (frameCount < 1 || frameCount > 256) return null;
    if (lacing === 2) {
        const payloadLength = data.length - offset;
        if (payloadLength % frameCount !== 0) return null;
        const frameLength = payloadLength / frameCount;
        const packets = [];
        for (let index = 0; index < frameCount; index++) {
            const start = offset + index * frameLength;
            packets.push(data.subarray(start, start + frameLength));
        }
        return { trackNumber: track.value, relativeTimecode, packets };
    }

    const sizes = [];
    let declaredSize = 0;
    if (lacing === 1) {
        for (let index = 0; index < frameCount - 1; index++) {
            let frameSize = 0;
            let byte;
            do {
                if (offset >= data.length) return null;
                byte = data[offset++];
                frameSize += byte;
            } while (byte === 255);
            sizes.push(frameSize);
            declaredSize += frameSize;
        }
    } else if (lacing === 3) {
        const first = readBlockVint(data, offset);
        if (!first) return null;
        offset += first.length;
        let previousSize = first.value;
        sizes.push(previousSize);
        declaredSize += previousSize;
        for (let index = 1; index < frameCount - 1; index++) {
            const deltaVint = readEbmlVint(data, offset, true);
            if (!deltaVint || deltaVint.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            offset += deltaVint.length;
            const bias = (1n << BigInt(7 * deltaVint.length - 1)) - 1n;
            const nextSize = BigInt(previousSize) + deltaVint.value - bias;
            if (nextSize < 0n || nextSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            previousSize = Number(nextSize);
            sizes.push(previousSize);
            declaredSize += previousSize;
        }
    } else {
        return null;
    }

    const lastSize = data.length - offset - declaredSize;
    if (lastSize < 0) return null;
    sizes.push(lastSize);
    const packets = [];
    let cursor = offset;
    for (const size of sizes) {
        if (!Number.isSafeInteger(size) || size <= 0 || cursor + size > data.length) return null;
        packets.push(data.subarray(cursor, cursor + size));
        cursor += size;
    }
    if (cursor !== data.length) return null;
    return { trackNumber: track.value, relativeTimecode, packets };
};

const getOpusPacketDurationMs = (packet) => {
    const toc = packet[0];
    if (toc === undefined) return 20;
    const config = toc >> 3;
    let frameDurationMs;
    if (config >= 16) frameDurationMs = [2.5, 5, 10, 20][config & 0x03] ?? 20;
    else if (config >= 12) frameDurationMs = (config & 0x01) === 0 ? 10 : 20;
    else frameDurationMs = [10, 20, 40, 60][config & 0x03] ?? 20;

    const frameCode = toc & 0x03;
    let frameCount = 1;
    if (frameCode === 1 || frameCode === 2) frameCount = 2;
    else if (frameCode === 3) frameCount = packet[1] === undefined ? 0 : (packet[1] >> 2) & 0x3f;
    const duration = frameDurationMs * frameCount;
    return frameCount > 0 && duration <= 120 ? duration : 20;
};

const getWebmAudioEndMs = (buffer, headerInfo) => {
    if (!headerInfo || headerInfo.codecId !== 'A_OPUS' || !Number.isSafeInteger(headerInfo.audioTrackNumber)) return null;
    const clusterId = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
    let searchFrom = buffer.length;
    let latestEndMs = null;
    const timecodeScaleNs = headerInfo.timecodeScaleNs || 1000000n;
    const codecDelayNs = headerInfo.codecDelayNs || 0n;

    while (searchFrom > 0) {
        const clusterOffset = buffer.lastIndexOf(clusterId, searchFrom - 1);
        if (clusterOffset < 0) break;
        searchFrom = clusterOffset;
        const cluster = readEbmlElement(buffer, clusterOffset);
        if (!cluster || cluster.id !== '1f43b675' || cluster.dataStart >= cluster.dataEnd || cluster.dataEnd > buffer.length) continue;

        let clusterTimecode = null;
        const blockData = [];
        for (let childOffset = cluster.dataStart; childOffset < cluster.dataEnd;) {
            const child = readEbmlElement(buffer, childOffset);
            if (!child || child.nextOffset <= childOffset) break;
            if (child.id === 'e7') {
                clusterTimecode = readEbmlUint(buffer, child.dataStart, child.dataEnd);
            } else if (child.id === 'a3') {
                blockData.push(buffer.subarray(child.dataStart, child.dataEnd));
            } else if (child.id === 'a0') {
                for (let groupOffset = child.dataStart; groupOffset < child.dataEnd;) {
                    const groupChild = readEbmlElement(buffer, groupOffset);
                    if (!groupChild || groupChild.nextOffset <= groupOffset) break;
                    if (groupChild.id === 'a1') blockData.push(buffer.subarray(groupChild.dataStart, groupChild.dataEnd));
                    groupOffset = groupChild.nextOffset;
                }
            }
            childOffset = child.nextOffset;
        }

        if (clusterTimecode === null) continue;
        for (const data of blockData) {
            const block = parseOpusBlockPackets(data);
            if (!block || block.trackNumber !== headerInfo.audioTrackNumber) continue;
            const blockStartNs = (clusterTimecode + BigInt(block.relativeTimecode)) * timecodeScaleNs - codecDelayNs;
            let packetStartMs = Number(blockStartNs) / 1_000_000;
            for (const packet of block.packets) {
                const packetDurationMs = getOpusPacketDurationMs(packet);
                if (Number.isFinite(packetStartMs) && packetDurationMs > 0) {
                    const packetEndMs = packetStartMs + packetDurationMs;
                    if (latestEndMs === null || packetEndMs > latestEndMs) latestEndMs = packetEndMs;
                }
                packetStartMs += packetDurationMs;
            }
        }
    }

    if (!Number.isFinite(latestEndMs) || latestEndMs <= 0) return null;
    if (Number.isFinite(headerInfo.durationMs) && headerInfo.durationMs > 0 && latestEndMs > headerInfo.durationMs + 120) return null;
    return latestEndMs;
};

async function loadWebmCueIndex(
    parsedUrl,
    contentLength,
    customHeaders,
    customRequestFn,
    headerInfo,
    cacheEntry,
    cacheKey,
    prewarm = false
) {
    if (cacheEntry?.cueIndex?.loaded) return cacheEntry.cueIndex;

    // If the small background prewarm is already running, let it finish first.
    // It may satisfy the seek without downloading the larger fallback tail.
    if (!prewarm && cacheEntry?.cueIndexPrewarmPromise) {
        const warmedIndex = await cacheEntry.cueIndexPrewarmPromise;
        if (warmedIndex?.loaded && cacheEntry.cueIndex?.loaded) {
            return cacheEntry.cueIndex;
        }
    }

    const promiseField = prewarm ? 'cueIndexPrewarmPromise' : 'cueIndexPromise';
    if (cacheEntry?.[promiseField]) return cacheEntry[promiseField];

    const inflightKey = `${cacheKey || parsedUrl.toString()}|${prewarm ? 'prewarm' : 'full'}`;
    const loadPromise = getOrCreateSharedPromise(
        WEBM_CUE_INDEX_INFLIGHT,
        inflightKey,
        async () => {
            const tailLimit = prewarm ? WEBM_SEEK_PREWARM_TAIL_BYTES : 8 * 1024 * 1024;
            const tailLength = Math.min(contentLength, tailLimit);
            const tailStart = contentLength - tailLength;
            const tail = await fetchWithRange(
                parsedUrl,
                tailStart,
                contentLength - 1,
                customHeaders,
                customRequestFn
            );
            const cuePoints = parseWebmCues(tail);
            return {
                loaded: !prewarm || cuePoints.length > 0,
                cuePoints,
                audioDurationMs: getWebmAudioEndMs(tail, headerInfo)
            };
        }
    );

    if (cacheEntry) cacheEntry[promiseField] = loadPromise;
    try {
        const cueIndex = await loadPromise;
        if (cacheEntry) {
            if (cueIndex.loaded) cacheEntry.cueIndex = cueIndex;
            if (Number.isFinite(cueIndex.audioDurationMs) && cueIndex.audioDurationMs > 0) {
                cacheEntry.audioDurationMs = cueIndex.audioDurationMs;
            }
        }
        return cueIndex;
    } finally {
        if (cacheEntry) cacheEntry[promiseField] = null;
    }
}

function selectWebmCueSeekPoint(cuePoints, headerInfo, targetTimeMs, contentLength) {
    if (!cuePoints?.length || !headerInfo) return null;

    const targetNs = BigInt(Math.max(0, Math.round(targetTimeMs * 1_000_000)));
    const preRollNs = headerInfo.seekPreRollNs ?? 80000000n;
    const codecDelayNs = headerInfo.codecDelayNs ?? 0n;
    let thresholdNs = targetNs - preRollNs + codecDelayNs;
    if (thresholdNs < 0n) thresholdNs = 0n;
    const thresholdTicks = thresholdNs / (headerInfo.timecodeScaleNs || 1000000n);

    let trackCues = cuePoints;
    if (headerInfo.audioTrackNumber !== null) {
        const audioTrackCues = cuePoints.filter(
            (cue) => cue.cueTrack === headerInfo.audioTrackNumber
        );
        const untypedCues = cuePoints.filter((cue) => cue.cueTrack === null);
        trackCues = audioTrackCues.length
            ? audioTrackCues
            : untypedCues.length
                ? untypedCues
                : cuePoints;
    }
    if (!trackCues.length) return null;

    let selected = null;
    for (const cue of trackCues) {
        if (cue.cueTime <= thresholdTicks && (!selected || cue.cueTime > selected.cueTime)) {
            selected = cue;
        }
    }
    if (!selected || selected.clusterPosition > BigInt(Number.MAX_SAFE_INTEGER)) return null;

    const clusterOffset = headerInfo.segmentDataOffset + Number(selected.clusterPosition);
    if (
        !Number.isSafeInteger(clusterOffset) ||
        clusterOffset < headerInfo.firstClusterOffset ||
        clusterOffset + 4 > contentLength
    ) return null;

    return {
        clusterOffset,
        clusterTimeMs: Number(selected.cueTime * (headerInfo.timecodeScaleNs || 1000000n)) / 1_000_000,
        cueTime: selected.cueTime
    };
}

async function findWebmCueSeekPoint(
    parsedUrl,
    contentLength,
    customHeaders,
    customRequestFn,
    headerInfo,
    targetTimeMs,
    cacheEntry,
    cacheKey
) {
    if (!headerInfo || !Number.isFinite(targetTimeMs) || targetTimeMs <= 0) {
        return { seekPoint: null, cueIndex: null };
    }
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
        return { seekPoint: null, cueIndex: null };
    }

    let cueIndex;
    try {
        cueIndex = await loadWebmCueIndex(
            parsedUrl,
            contentLength,
            customHeaders,
            customRequestFn,
            headerInfo,
            cacheEntry,
            cacheKey
        );
    } catch {
        // Preserve the sequential fallback when the tail/index cannot be read.
        return { seekPoint: null, cueIndex: null };
    }

    if (!cueIndex.cuePoints.length) {
        return { seekPoint: null, cueIndex };
    }

    const seekPoint = selectWebmCueSeekPoint(cueIndex.cuePoints, headerInfo, targetTimeMs, contentLength);
    if (!seekPoint) return { seekPoint: null, cueIndex };

    // CueClusterPosition is a Segment-relative Cluster offset. Do not issue a
    // separate 4-byte HTTP request for every new seek: the subsequent media
    // Range starts at this exact offset and the WebM demuxer validates EBML.
    return { seekPoint, cueIndex };
}

function detectContentType(buffer, originalMime, urlString = '') {
    if (!buffer || buffer.length < 4) return originalMime;

    const hex = buffer.toString('hex', 0, 4);
    const ascii = buffer.toString('ascii', 0, 4);

    if (ascii === 'fLaC') return 'audio/flac';

    // Detecção de MPEG Audio / AAC ADTS
    // Ambos os formatos usam padrões de sincronização começando com 0xFF e bits superiores do byte 1 setados
    // A diferença chave está nos "layer bits" (bits 1-2 do byte 1):
    // - AAC ADTS: layer bits = 00 (valor 0)
    // - MP3 Layer I: layer bits = 11 (valor 3)
    // - MP3 Layer II: layer bits = 10 (valor 2)
    // - MP3 Layer III: layer bits = 01 (valor 1)
    if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) {
        const layerBits = (buffer[1] & 0x06) >> 1;  // Extrai bits 1-2
        if (layerBits === 0) {
            // Layer bits são 00 - isso é AAC ADTS
            return 'audio/aac';
        } else {
            // Layer bits são diferentes de zero - isso é MPEG audio (MP3)
            return 'audio/mpeg';
        }
    }

    if (hex.startsWith('494433')) {
        const ext = urlString.split('?')[0].split('.').pop().toLowerCase();
        if (ext === 'aac' || (originalMime && originalMime.includes('aac'))) return 'audio/aac';
        return 'audio/mpeg';
    }


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

    const webmCacheKey = parsedUrl.protocol === 'file:'
        ? null
        : createWebmSeekCacheKey(parsedUrl, httpHeaders);
    let webmCacheEntry = getWebmSeekCache(webmCacheKey);
    const cachedWebmMetadata = Boolean(
        webmCacheEntry &&
        webmCacheEntry.headerInfo &&
        Buffer.isBuffer(webmCacheEntry.probeData) &&
        webmCacheEntry.contentLength > 0
    );

    let contentLength = 0;
    let contentType = 'application/octet-stream';
    let acceptRanges = 'none';

    if (cachedWebmMetadata) {
        contentLength = webmCacheEntry.contentLength;
        contentType = webmCacheEntry.contentType || contentType;
        acceptRanges = webmCacheEntry.acceptRanges || 'bytes';
    } else if (parsedUrl.protocol === 'file:') {
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
    } else if (!cachedWebmMetadata) {
        try {
            const headMetadata = await getOrCreateSharedPromise(
                WEBM_HEAD_INFLIGHT,
                webmCacheKey || parsedUrl.toString(),
                async () => {
                    const response = await makeHttpRequest(
                        parsedUrl,
                        { method: 'HEAD', headers: httpHeaders },
                        customRequestFn
                    );
                    const result = {
                        statusCode: response.statusCode,
                        contentLength: parseInt(response.headers?.['content-length'], 10) || 0,
                        contentType: response.headers?.['content-type'] || 'application/octet-stream',
                        acceptRanges: response.headers?.['accept-ranges'] || 'none'
                    };
                    response.resume();
                    return result;
                }
            );

            if (headMetadata.statusCode >= 400) {
                meta.warnings.push(`HEAD error ${headMetadata.statusCode}, trying blind probe.`);
            } else {
                contentLength = headMetadata.contentLength;
                contentType = headMetadata.contentType || contentType;
                acceptRanges = headMetadata.acceptRanges || acceptRanges;
            }

        } catch (error) {
            meta.warnings.push(`Could not retrieve HEAD metadata for ${urlString}. Error: ${error.message}`);
        }
    }

    const PROBE_BYTES = 32 * 1024;
    let probeData = cachedWebmMetadata ? Buffer.from(webmCacheEntry.probeData) : Buffer.alloc(0);

    if (cachedWebmMetadata) {
        // HEAD and the initial EBML probe are already stored for this media URL.
    } else if (parsedUrl.protocol === 'file:') {
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
            probeData = await getOrCreateSharedPromise(
                WEBM_PROBE_INFLIGHT,
                `${webmCacheKey || parsedUrl.toString()}|probe:${probeEnd}`,
                () => fetchWithRange(parsedUrl, 0, probeEnd, httpHeaders, customRequestFn)
            );
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

    let isWebm = false;
    let webmHeaderInfo = null;
    let webmSeekPoint = null;

    if (probeData.length > 0) {
        if (probeData.length >= 4 && probeData.readUInt32BE(0) === 0x1A45DFA3) {
            isWebm = true;
            webmHeaderInfo = getWebmHeaderInfo(probeData);
            if (Number.isFinite(webmHeaderInfo?.durationMs) && webmHeaderInfo.durationMs > 0) {
                meta.durationMs = webmHeaderInfo.durationMs;
                meta.durationSource = 'container';
            }

            try {
                const decoder = new Decoder();
                const elms = decoder.decode(probeData);
                const durationEl = elms.find(e => e.name === 'Duration');
                const timecodeScaleEl = elms.find(e => e.name === 'TimecodeScale');
                const codecIdEl = elms.find(e => e.name === 'CodecID');

                if (durationEl && durationEl.type !== 'm') {
                    const duration = durationEl.value;
                    const timecodeScale = (timecodeScaleEl && timecodeScaleEl.type !== 'm')
                        ? timecodeScaleEl.value
                        : 1000000;
                    meta.durationMs = duration * (timecodeScale / 1000000);
                    meta.durationSource = 'container';
                }

                const codecId = webmHeaderInfo?.codecId ?? (
                    codecIdEl && codecIdEl.type !== 'm' ? codecIdEl.value : null
                );
                const mime = codecId === 'A_OPUS'
                    ? 'audio/opus'
                    : codecId === 'A_VORBIS'
                        ? 'audio/vorbis'
                        : codecId
                            ? `audio/webm; codecs=${codecId.toLowerCase()}`
                            : 'audio/webm';

                meta.contentType = mime;
                meta.codec = {
                    container: 'webm',
                    mime,
                    codecName: codecId
                };
            } catch (error) {
                const codecId = webmHeaderInfo?.codecId ?? null;
                const mime = codecId === 'A_OPUS' ? 'audio/opus' : 'audio/webm';
                meta.contentType = mime;
                meta.codec = { container: 'webm', mime, codecName: codecId };
                meta.warnings.push(`Error parsing probeData with ts-ebml: ${error.message}. Using the bounded EBML header parser.`);
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

    if (
        isWebm &&
        webmCacheKey &&
        contentLength > 0 &&
        acceptRanges === 'bytes' &&
        webmHeaderInfo
    ) {
        webmCacheEntry = webmCacheEntry || {};
        webmCacheEntry.contentLength = contentLength;
        webmCacheEntry.contentType = detectContentType(probeData, contentType, urlString);
        webmCacheEntry.acceptRanges = acceptRanges;
        webmCacheEntry.probeData = Buffer.from(probeData);
        webmCacheEntry.headerInfo = webmHeaderInfo;
        webmCacheEntry.cueIndex = webmCacheEntry.cueIndex || null;
        webmCacheEntry.prefixBuffer = webmCacheEntry.prefixBuffer || null;
        webmCacheEntry.prefixPromise = webmCacheEntry.prefixPromise || null;
        // The first play request already fetched the EBML probe. Reuse those
        // bytes as the header prefix whenever the complete prefix is present.
        if (webmHeaderInfo.firstClusterOffset <= probeData.length && !webmCacheEntry.prefixBuffer) {
            webmCacheEntry.prefixBuffer = Buffer.from(
                probeData.subarray(0, webmHeaderInfo.firstClusterOffset)
            );
        }
        webmCacheEntry.cueIndexPrewarmPromise = webmCacheEntry.cueIndexPrewarmPromise || null;
        webmCacheEntry = setWebmSeekCache(webmCacheKey, webmCacheEntry);

        // Warm a small tail window without delaying initial playback. Most
        // WebM Cues are near EOF, so the first actual seek can often use the
        // in-memory index immediately. Larger fallback reads happen only if
        // a later seek proves the small window did not contain Cues.
        if (WEBM_SEEK_PREWARM_ENABLED && startTime === 0 && !webmCacheEntry.cueIndex) {
            void loadWebmCueIndex(
                parsedUrl,
                contentLength,
                httpHeaders,
                customRequestFn,
                webmHeaderInfo,
                webmCacheEntry,
                webmCacheKey,
                true
            ).catch(() => {});
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
        meta.durationSource = 'estimated';
    }

    if (isWebm && typeof startTime === 'number' && startTime > 0) {
        // WebM bitrate is not constant. Never estimate a byte offset from
        // duration/contentLength; use Cues when available, otherwise decode
        // sequentially from byte zero and trim PCM by the actual block times.
        startByte = 0;
        endByte = contentLength > 0 ? contentLength - 1 : Infinity;

        if (
            parsedUrl.protocol !== 'file:' &&
            acceptRanges === 'bytes' &&
            contentLength > 0 &&
            webmHeaderInfo?.firstClusterOffset !== null &&
            webmHeaderInfo?.firstClusterOffset !== undefined
        ) {
            const webmSeekResult = await findWebmCueSeekPoint(
                parsedUrl,
                contentLength,
                httpHeaders,
                customRequestFn,
                webmHeaderInfo,
                startTime,
                webmCacheEntry,
                webmCacheKey
            );
            webmSeekPoint = webmSeekResult.seekPoint;
            if (webmSeekResult.cueIndex && webmCacheEntry) {
                webmCacheEntry.cueIndex = webmSeekResult.cueIndex;
                if (Number.isFinite(webmSeekResult.cueIndex.audioDurationMs) && webmSeekResult.cueIndex.audioDurationMs > 0) {
                    webmCacheEntry.audioDurationMs = webmSeekResult.cueIndex.audioDurationMs;
                }
                setWebmSeekCache(webmCacheKey, webmCacheEntry);
            }
            if (webmSeekPoint) startByte = webmSeekPoint.clusterOffset;
            if (Number.isFinite(webmCacheEntry?.audioDurationMs) && webmCacheEntry.audioDurationMs > 0) {
                webmHeaderInfo.audioDurationMs = webmCacheEntry.audioDurationMs;
            }
            if (Number.isFinite(webmHeaderInfo?.audioDurationMs) && webmHeaderInfo.audioDurationMs > 0) {
                meta.audioDurationMs = webmHeaderInfo.audioDurationMs;
                meta.audioDurationSource = 'audio-packets';
            }
        }

        if (!webmSeekPoint) {
            meta.warnings.push(
                'WebM seek index unavailable; falling back to sequential decoding from the beginning.'
            );
        }

        if (typeof endTime === 'number' && endTime > 0) {
            meta.warnings.push(
                'WebM endTime byte truncation is disabled because duration-to-byte mapping is not reliable for variable-bitrate media.'
            );
        }
    } else if (acceptRanges === 'bytes' && contentLength > 0 && effectiveDurationMs > 0) {
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
        meta.warnings.push('Server does not support byte ranges or unknown Content-Length. Full streaming will be attempted, ignoring byte-range seeking.');
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

    if (
        isWebm &&
        webmSeekPoint &&
        webmHeaderInfo &&
        webmHeaderInfo.firstClusterOffset !== null
    ) {
        const { PassThrough } = await import('stream');
        const finalStream = new PassThrough();
        const headerEndOffset = webmHeaderInfo.firstClusterOffset;
        const selectedClusterOffset = webmSeekPoint.clusterOffset;

        const writeChunk = async (chunk) => {
            if (finalStream.destroyed) return false;
            if (finalStream.write(chunk)) return true;

            await new Promise((resolve) => {
                const finish = () => {
                    finalStream.removeListener('drain', finish);
                    finalStream.removeListener('close', finish);
                    finalStream.removeListener('error', finish);
                    resolve();
                };
                finalStream.once('drain', finish);
                finalStream.once('close', finish);
                finalStream.once('error', finish);
            });
            return !finalStream.destroyed;
        };

        const pipeMedia = async () => {
            try {
                let cachedPrefix = null;
                try {
                    cachedPrefix = await getWebmHeaderPrefix(
                        parsedUrl,
                        headerEndOffset,
                        httpHeaders,
                        customRequestFn,
                        webmCacheEntry,
                        webmCacheKey
                    );
                } catch {
                    // Fall back to the retrying chunk stream if the small
                    // prefix request was interrupted.
                    cachedPrefix = null;
                }

                if (cachedPrefix) {
                    if (!(await writeChunk(cachedPrefix))) return;
                } else {
                    const headerStream = createHttpStream(
                        parsedUrl,
                        0,
                        headerEndOffset - 1,
                        httpHeaders,
                        customRequestFn
                    );
                    for await (const chunk of headerStream) {
                        if (!(await writeChunk(chunk))) return;
                    }
                }

                const fragmentStream = createHttpStream(
                    parsedUrl,
                    selectedClusterOffset,
                    endByte,
                    httpHeaders,
                    customRequestFn
                );
                for await (const chunk of fragmentStream) {
                    if (!(await writeChunk(chunk))) return;
                }

                if (!finalStream.destroyed) finalStream.end();
            } catch (error) {
                if (!finalStream.destroyed) finalStream.destroy(error);
            }
        };

        void pipeMedia();

        const prefixLength = headerEndOffset;
        const fragmentLength = contentLength > 0
            ? Math.max(0, Math.min(contentLength - 1, endByte) - selectedClusterOffset + 1)
            : undefined;
        meta.contentLength = fragmentLength === undefined
            ? undefined
            : prefixLength + fragmentLength;
        meta.resolvedRange = {
            start: 0,
            end: meta.contentLength === undefined ? Infinity : meta.contentLength - 1
        };
        meta.webmSeekClusterTimeMs = webmSeekPoint.clusterTimeMs;
        meta.webmSeekTargetMs = startTime;
        meta.webmSeekClusterOffset = selectedClusterOffset;
        meta.webmSeekPreRollMs = Number(webmHeaderInfo.seekPreRollNs) / 1_000_000;
        meta.originalSeekRange = { start: selectedClusterOffset, end: endByte };
        meta.webmHeaderPrepended = true;

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
