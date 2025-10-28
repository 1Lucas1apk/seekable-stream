import { Readable } from 'stream';
import { URL } from 'url';
import http from 'http';
import https from 'https';
import fs from 'fs/promises';
import CodecParser from 'codec-parser';
import { WebmParser } from './webm/index.js';

class SeekError extends Error {
	constructor(code, message, hint = '', traceId = '', resolvedRanges = []) {
		super(message);
		this.name = 'SeekError';
		this.code = code;
		this.hint = hint;
		this.traceId = traceId;
		this.resolvedRanges = resolvedRanges;
	}
}

async function makeHttpRequest(url, options, customRequestFn = null) {
    if (customRequestFn) {
        return customRequestFn(url, options);
    }

    const client = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
        const req = client.request(url, options, (res) => resolve(res));
        req.on('error', reject);
        req.end();
    });
}

async function fetchWithRange(url, start, end, customHeaders = {}, customRequestFn = null) {
	const headers = {
		'Range': `bytes=${start}-${end}`,
		...customHeaders,
	};

	const response = await makeHttpRequest(url, { headers }, customRequestFn);

	if (response.statusCode >= 400) {
		throw new SeekError('HTTP_ERROR', `Error fetching range ${start}-${end}: ${response.statusCode} ${response.statusMessage}`);
	}
	if (response.statusCode !== 206 && response.statusCode !== 200) {
		throw new SeekError('UNEXPECTED_HTTP_STATUS', `Unexpected HTTP status: ${response.statusCode}`);
	}

	const chunks = [];
	for await (const chunk of response) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function createLocalFileStream(filePath, start, end) {
	return fs.createReadStream(filePath, { start, end });
}

function createHttpStream(parsedUrl, start, end, customHeaders = {}, customRequestFn = null) {
	const headers = {
		'Range': `bytes=${start}-${end === Infinity ? '' : end}`,
		...customHeaders,
	};

	let httpRequest = null;
	let httpResponse = null;
	let requestInProgress = false;
	let streamClosed = false;

	const stream = new Readable({
		async read(size) {
			if (streamClosed || requestInProgress) return;

			if (httpResponse && httpResponse.readable) {
				httpResponse.resume();
				return;
			}

			requestInProgress = true;

			try {
				const response = await makeHttpRequest(parsedUrl, { headers }, customRequestFn);

				if (response.statusCode >= 400) {
					this.emit('error', new SeekError('HTTP_STREAM_ERROR', `Error fetching HTTP stream: ${response.statusCode} ${response.statusMessage}`));
					requestInProgress = false;
					streamClosed = true;
					return;
				}
				if (response.statusCode !== 206 && response.statusCode !== 200) {
					this.emit('error', new SeekError('UNEXPECTED_HTTP_STATUS', `Unexpected HTTP status for stream: ${response.statusCode}`));
					requestInProgress = false;
					streamClosed = true;
					return;
				}

				httpResponse = response;

				httpResponse.on('data', (chunk) => {
					if (!this.push(chunk)) httpResponse.pause();
				});
				httpResponse.on('end', () => {
					this.push(null);
					requestInProgress = false;
					streamClosed = true;
				});
				httpResponse.on('error', (err) => {
					this.emit('error', new SeekError('HTTP_STREAM_ERROR', `Error in HTTP stream: ${err.message}`));
					requestInProgress = false;
					streamClosed = true;
				});

				this.on('close', () => {
					if (httpRequest && httpRequest.destroy) httpRequest.destroy();
					if (httpResponse) httpResponse.destroy();
					streamClosed = true;
				});

			} catch (error) {
				this.emit('error', new SeekError('HTTP_STREAM_INIT_ERROR', `Error initializing HTTP stream: ${error.message}`));
				requestInProgress = false;
				streamClosed = true;
			}
		}
	});

	return stream;
}

export function estimateBitrate(contentLength, durationMs, contentType) {
	if (contentLength > 0 && durationMs > 0) {
		const bitrateBps = (contentLength * 8 * 1000) / durationMs;
		return bitrateBps / 1000;
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
	try { parsedUrl = new URL(urlString); } catch (error) { throw new SeekError('INVALID_URL', `URL inválida: ${urlString}`); }
	if (!['http:', 'https:', 'file:'].includes(parsedUrl.protocol)) throw new SeekError('UNSUPPORTED_PROTOCOL', `Protocolo não suportado: ${parsedUrl.protocol}. Apenas http(s) e file:// são suportados.`);

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
			throw new SeekError('FILE_ACCESS_ERROR', `Erro ao acessar arquivo local: ${parsedUrl.pathname}. ${error.message}`);
		}
	} else {
		try {
			const response = await makeHttpRequest(parsedUrl, { method: 'HEAD', headers: httpHeaders }, customRequestFn);
			if (response.statusCode >= 400) throw new SeekError('HTTP_HEAD_ERROR', `Error making HEAD request to ${urlString}: ${response.statusCode} ${response.statusMessage}`);
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
					'opus': 'audio/ogg',
					'webm': 'audio/webm'
				};
				contentType = mimeTypes[extension] || contentType;
			}
		} catch (error) {
			meta.warnings.push(`Could not retrieve HEAD metadata for ${urlString}. Error: ${error.message}`);
		}
	}

	meta.contentType = contentType;
	meta.contentLength = contentLength;
	meta.acceptRanges = acceptRanges;

	const PROBE_BYTES = 512 * 1024;
	let probeData = Buffer.alloc(0);
	if (parsedUrl.protocol === 'file:') {
		try {
			const fileHandle = await fs.open(parsedUrl.pathname, 'r');
			const buffer = Buffer.alloc(PROBE_BYTES);
			const { bytesRead } = await fileHandle.read(buffer, 0, PROBE_BYTES, 0);
			probeData = buffer.slice(0, bytesRead);
			await fileHandle.close();
		} catch (error) {
			throw new SeekError('FILE_PROBE_ERROR', `Erro ao fazer probe do arquivo local: ${parsedUrl.pathname}. ${error.message}`);
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
			                try {
			                    const webmInfo = WebmParser.parseWebm(probeData);
			                    isWebm = true;
			                    if (webmInfo.metadata && webmInfo.metadata.duration) {
			                        meta.durationMs = webmInfo.metadata.duration;
			                    }
			                    if (webmInfo.firstClusterOffset) {
			                        meta.webmHeaderEndOffset = webmInfo.firstClusterOffset;
			                    }
			
			                    if (webmInfo.audioTrack) {
			                        meta.codec = {
			                            container: 'webm',
			                            mime: meta.contentType,
			                            codecName: webmInfo.audioTrack.codecId,
			                            codecPrivate: webmInfo.audioTrack.codecPrivate
			                        };
			                        if (webmInfo.audioTrack.codecId === 'A_OPUS') {
			                            meta.contentType = 'audio/opus';
			                        } else if (webmInfo.audioTrack.codecId === 'A_VORBIS') {
			                            meta.contentType = 'audio/vorbis';
			                        }
			                        meta.codec.mime = meta.contentType;
			                    } else {
			                        meta.warnings.push('WebM file found, but no audio track detected.');
			                    }
			                } catch (error) {
			                    					meta.warnings.push(`Error parsing probeData as WebM with WebmParser: ${error.message}. Attempting CodecParser.`);			                    isWebm = false;
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
			                            }
			                        } else {
			                            meta.codec = undefined;
			                        }
			                    } catch (error) {
			                        					meta.warnings.push(`Error parsing probeData with codec-parser: ${error.message}`);			                    }
			                }
			            }
	    let startByte = 0;
	    let endByte = contentLength > 0 ? contentLength - 1 : Infinity;
	    let effectiveDurationMs = meta.durationMs;
	
	    if (!effectiveDurationMs && meta.contentLength > 0) {
	        const estimatedBitrateKbps = estimateBitrate(meta.contentLength, 0, meta.contentType);
	        effectiveDurationMs = (meta.contentLength * 8) / (estimatedBitrateKbps * 1000) * 1000;
	    }
	
	    if (effectiveDurationMs > 0 && !meta.durationMs) meta.durationMs = effectiveDurationMs;
	
	    // Logic to calculate startByte and endByte based on startTime/endTime
	    if (startTime !== undefined || (endTime !== undefined && endTime !== 0)) {
	        if (acceptRanges === 'bytes' && contentLength > 0 && effectiveDurationMs > 0) {
	            if (startTime !== undefined) {
	                startByte = Math.floor((startTime / effectiveDurationMs) * contentLength);
	            }
	            if (endTime !== undefined && endTime !== 0) {
	                endByte = Math.min(contentLength - 1, Math.floor((endTime / effectiveDurationMs) * contentLength));
	            } else { // endTime is undefined or 0, so go to end of file
	                endByte = contentLength > 0 ? contentLength - 1 : Infinity;
	            }
	        } else {
	            meta.warnings.push('Server does not support byte ranges or unknown Content-Length. Full streaming will be attempted, ignoring startTime/endTime.');
	        }
	    }
	
	    if (startTime === undefined) startByte = 0;
	    if (endTime === undefined || endTime === 0) endByte = contentLength > 0 ? contentLength - 1 : Infinity;
	
	    meta.resolvedRange = { start: startByte, end: endByte };
        if (meta.codec && meta.codec.container === 'webm' && startByte > 0 && meta.webmHeaderEndOffset) {

            const { PassThrough } = await import('stream');

            const finalStream = new PassThrough();

                        let headerBuffer = await new Promise((resolve, reject) => {

                            const chunks = [];

                            const stream = parsedUrl.protocol === 'file:'

                                ? createLocalFileStream(parsedUrl.pathname, 0, meta.webmHeaderEndOffset - 1)

                                : createHttpStream(parsedUrl, 0, meta.webmHeaderEndOffset - 1, httpHeaders, customRequestFn);

                            stream.on('data', (chunk) => chunks.push(chunk));

                            stream.on('end', () => resolve(Buffer.concat(chunks)));

                            stream.on('error', reject);

                        });

                                    headerBuffer = WebmParser.removeEbmlElement(headerBuffer, WebmParser.SEEK_HEAD_ID);

                                    headerBuffer = WebmParser.removeEbmlElement(headerBuffer, WebmParser.CUES_ID);

                                                let segmentDurationMs;

                                                if (startTime !== undefined && endTime !== undefined && endTime !== 0) {

                                                    segmentDurationMs = endTime - startTime;

                                                } else if (startTime !== undefined) {

                                                    segmentDurationMs = meta.durationMs - startTime;

                                                } else {

                                                    segmentDurationMs = meta.durationMs;

                                                }

                                                headerBuffer = WebmParser.updateDuration(headerBuffer, segmentDurationMs, meta.timecodeScale);

                        const headerStream = new Readable();

                        headerStream.push(headerBuffer);

                        headerStream.push(null);

            const dataStreamStart = Math.max(startByte, meta.webmHeaderEndOffset);
            const dataStream = parsedUrl.protocol === 'file:'
                ? createLocalFileStream(parsedUrl.pathname, dataStreamStart, endByte)
                : createHttpStream(parsedUrl, dataStreamStart, endByte, httpHeaders, customRequestFn);

            headerStream.on('error', (err) => finalStream.emit('error', err));

            dataStream.on('error', (err) => finalStream.emit('error', err));

            headerStream.pipe(finalStream, { end: false });

            headerStream.on('end', () => {
                dataStream.pipe(finalStream);
            });

            const originalStartByte = startByte;

            const originalEndByte = endByte;

            meta.resolvedRange = {

                start: 0,

                end: originalEndByte

            };

            let combinedContentLength = (meta.webmHeaderEndOffset);
            if (originalEndByte !== Infinity) {
                combinedContentLength += (originalEndByte - dataStreamStart + 1);
            } else if (meta.contentLength > 0) {
                combinedContentLength += (meta.contentLength - dataStreamStart);
            }

            meta.contentLength = combinedContentLength;

            if (originalEndByte === Infinity && meta.contentLength === 0) {

                				meta.warnings.push('Combined stream Content-Length is unknown due to endByte=Infinity and unknown original contentLength.');
            }

            meta.webmHeaderPrepended = true;

            meta.originalSeekRange = { start: originalStartByte, end: originalEndByte };

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