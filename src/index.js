import { Readable } from 'stream';
import { URL } from 'url';
import http from 'http';
import https from 'https';
import fs from 'fs/promises';
import CodecParser from 'codec-parser';
import createLibWebM from '@sctg/libwebm-js';

export class SeekError extends Error {
    constructor(code, message, hint = '', traceId = '', resolvedRanges = []) {
        super(message);
        this.name = 'SeekError';
        this.code = code;
        this.hint = hint;
        this.resolvedRanges = resolvedRanges;
        // Log da criação do erro
        console.error(`[DEBUG] [SeekError] Criando erro. Code: ${code}, Message: ${message}, Hint: ${hint}`);
    }
}

async function makeHttpRequest(url, options, customRequestFn = null) {
    console.log(`[DEBUG] [makeHttpRequest] Entry. URL: ${url.toString()}, Options: ${JSON.stringify(options)}, Has customRequestFn: ${!!customRequestFn}`);
    
    if (customRequestFn) {
        console.log('[DEBUG] [makeHttpRequest] Usando customRequestFn.');
        return customRequestFn(url, options);
    }

    const client = url.protocol === 'http:' ? http : https;
    console.log(`[DEBUG] [makeHttpRequest] Usando cliente: ${url.protocol === 'http:' ? 'http' : 'https'}`);

    return new Promise((resolve, reject) => {
        console.log('[DEBUG] [makeHttpRequest] Criando request...');
        const req = client.request(url, options, (res) => {
            console.log(`[DEBUG] [makeHttpRequest] Resposta recebida. Status: ${res.statusCode}, Headers: ${JSON.stringify(res.headers)}`);
            resolve(res);
        });
        
        req.on('error', (err) => {
            console.error('[DEBUG] [makeHttpRequest] Request error:', err);
            reject(err);
        });
        
        console.log('[DEBUG] [makeHttpRequest] Encerrando request.');
        req.end();
    });
}

async function fetchWithRange(url, start, end, customHeaders = {}, customRequestFn = null, chunkSize = 512 * 1024) {
    console.log(`[DEBUG] [fetchWithRange] Entry. URL: ${url.toString()}, Range: ${start}-${end}, ChunkSize: ${chunkSize}`);

    if (start > end && end !== Infinity) {
        console.warn('[DEBUG] [fetchWithRange] Range inválido (start > end), retornando buffer vazio.');
        return Buffer.alloc(0);
    }

    const allChunks = [];
    let currentPos = start;

    while (true) {
        console.log(`[DEBUG] [fetchWithRange] Loop iteration. currentPos: ${currentPos}`);
        
        const isInfinite = (end === Infinity);
        const chunkEnd = isInfinite ? currentPos + chunkSize - 1 : Math.min(currentPos + chunkSize - 1, end);
        console.log(`[DEBUG] [fetchWithRange] Calculado chunkEnd: ${chunkEnd}, isInfinite: ${isInfinite}`);

        if (!isInfinite && currentPos > chunkEnd) {
            console.log('[DEBUG] [fetchWithRange] Loop break: currentPos > chunkEnd.');
            break;
        }

        const rangeHeader = `bytes=${currentPos}-${chunkEnd}`;
        const headers = { ...customHeaders, 'Range': rangeHeader };
        console.log(`[DEBUG] [fetchWithRange] Requesting range: ${rangeHeader}`);

        console.log('[DEBUG] [fetchWithRange] Aguardando makeHttpRequest...');
        const response = await makeHttpRequest(url, { headers }, customRequestFn);
        console.log(`[DEBUG] [fetchWithRange] makeHttpRequest response status: ${response.statusCode}`);

        if (response.statusCode === 416) {
            console.warn('[DEBUG] [fetchWithRange] Status 416 (Range Not Satisfiable). Interrompendo loop.');
            break;
        }
        
        if (response.statusCode !== 206) {
            if (response.statusCode === 200 && start === 0) {
                console.warn('[DEBUG] [fetchWithRange] Status 200 com start=0. Servidor provavelmente não suporta ranges. Lendo stream completa.');
                for await (const chunk of response) {
                    console.log(`[DEBUG] [fetchWithRange] (Status 200) Recebido chunk de: ${chunk.length}`);
                    allChunks.push(chunk);
                }
                break;
            }
            console.error(`[DEBUG] [fetchWithRange] Status inesperado ${response.statusCode}. Lançando erro.`);
            throw new SeekError('UNEXPECTED_HTTP_STATUS', `Unexpected status for chunk ${rangeHeader}: ${response.statusCode}`);
        }

        let hasData = false;
        for await (const chunk of response) {
            console.log(`[DEBUG] [fetchWithRange] (Status 206) Recebido chunk de: ${chunk.length}`);
            allChunks.push(chunk);
            hasData = true;
        }

        if (!hasData) {
            console.log('[DEBUG] [fetchWithRange] Nenhum dado recebido neste chunk. Interrompendo loop.');
            break;
        }

        currentPos = chunkEnd + 1;
        console.log(`[DEBUG] [fetchWithRange] Atualizando currentPos para: ${currentPos}`);
        
        if (!isInfinite && currentPos > end) {
            console.log('[DEBUG] [fetchWithRange] Fim do range atingido. Interrompendo loop.');
            break;
        }
    }
    
    const finalBuffer = Buffer.concat(allChunks);
    console.log(`[DEBUG] [fetchWithRange] Saindo. Total de chunks: ${allChunks.length}. Tamanho total: ${finalBuffer.length}`);
    return finalBuffer;
}

function createLocalFileStream(filePath, start, end) {
    console.log(`[DEBUG] [createLocalFileStream] Entry. Path: ${filePath}, Start: ${start}, End: ${end}`);
    const stream = fs.createReadStream(filePath, { start, end });
    console.log('[DEBUG] [createLocalFileStream] Retornando file stream.');
    return stream;
}

async function* generateHttpChunks(parsedUrl, start, end, customHeaders, customRequestFn, chunkSize) {
    console.log(`[DEBUG] [generateHttpChunks] Generator iniciado. URL: ${parsedUrl.toString()}, Range: ${start}-${end}, ChunkSize: ${chunkSize}`);
    let currentPos = start;

    while (currentPos <= end || end === Infinity) {
        console.log(`[DEBUG] [generateHttpChunks] Loop iteration. currentPos: ${currentPos}`);
        
        const chunkEnd = (end === Infinity) ? currentPos + chunkSize - 1 : Math.min(currentPos + chunkSize - 1, end);
        console.log(`[DEBUG] [generateHttpChunks] Calculado chunkEnd: ${chunkEnd}`);
        
        if (currentPos > chunkEnd && end !== Infinity) {
            console.log('[DEBUG] [generateHttpChunks] Loop break: currentPos > chunkEnd.');
            break;
        }
        
        const headers = { ...customHeaders, Range: `bytes=${currentPos}-${chunkEnd}` };
        console.log(`[DEBUG] [generateHttpChunks] Requesting range: ${headers.Range}`);
        
        console.log('[DEBUG] [generateHttpChunks] Aguardando makeHttpRequest...');
        const response = await makeHttpRequest(parsedUrl, { headers }, customRequestFn);
        console.log(`[DEBUG] [generateHttpChunks] makeHttpRequest response status: ${response.statusCode}`);

        if (response.statusCode === 416) {
            console.warn('[DEBUG] [generateHttpChunks] Status 416. Interrompendo loop.');
            break; // We've gone past the end
        }
        
        if (response.statusCode !== 206) {
            if (response.statusCode === 200 && start === 0) {
                 console.warn('[DEBUG] [generateHttpChunks] Status 200 com start=0. Lendo stream completa.');
                 for await (const chunk of response) {
                     console.log(`[DEBUG] [generateHttpChunks] (Status 200) Yielding chunk de: ${chunk.length}`);
                     yield chunk;
                 }
                 break;
            }
            console.error(`[DEBUG] [generateHttpChunks] Status inesperado ${response.statusCode}. Lançando erro.`);
            throw new SeekError('UNEXPECTED_HTTP_STATUS', `Unexpected status for chunk: ${response.statusCode}`);
        }

        currentPos = chunkEnd + 1;
        console.log(`[DEBUG] [generateHttpChunks] Atualizando currentPos para: ${currentPos}`);
        
        let hasData = false;
        for await (const chunk of response) {
            console.log(`[DEBUG] [generateHttpChunks] (Status 206) Yielding chunk de: ${chunk.length}`);
            yield chunk;
            hasData = true;
        }
        
        if (!hasData) {
            console.log('[DEBUG] [generateHttpChunks] Nenhum dado recebido neste chunk. Interrompendo loop.');
            break; // No more data from server
        }
    }
    console.log('[DEBUG] [generateHttpChunks] Generator finalizado.');
}

function createHttpStream(parsedUrl, start, end, customHeaders = {}, customRequestFn = null, chunkSize = 256 * 1024) {
    console.log(`[DEBUG] [createHttpStream] Entry. URL: ${parsedUrl.toString()}, Range: ${start}-${end}`);
    console.log('[DEBUG] [createHttpStream] Retornando Readable.from(generator).');
    return Readable.from(generateHttpChunks(parsedUrl, start, end, customHeaders, customRequestFn, chunkSize));
}

export function estimateBitrate(contentLength, durationMs, contentType) {
    console.log(`[DEBUG] [estimateBitrate] Entry. ContentLength: ${contentLength}, DurationMs: ${durationMs}, ContentType: ${contentType}`);
    
    if (contentLength > 0 && durationMs > 0) {
        const bitrateBps = (contentLength * 8 * 1000) / durationMs;
        console.log(`[DEBUG] [estimateBitrate] Calculando bitrate a partir do tamanho e duração. Bitrate Bps: ${bitrateBps}`);
        const bitrateKbps = bitrateBps / 1000;
        console.log(`[DEBUG] [estimateBitrate] Retornando bitrate calculado (kbps): ${bitrateKbps}`);
        return bitrateKbps;
    }

    console.log('[DEBUG] [estimateBitrate] Usando lógica de bitrate padrão.');
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
            console.log(`[DEBUG] [estimateBitrate] Tipo correspondente: ${type}. Retornando padrão: ${defaultBitrates[type]}`);
            return defaultBitrates[type];
        }
    }
    
    console.log(`[DEBUG] [estimateBitrate] Nenhuma correspondência. Retornando padrão: ${defaultBitrates.default}`);
    return defaultBitrates.default;
}

export async function seekableStream(urlString, startTime, endTime, httpHeaders = {}, customRequestFn = null) {
    console.log(`\n[DEBUG] [seekableStream] ========== NOVA REQUISIÇÃO SEEKABLE STREAM ==========`);
    console.log(`[DEBUG] [seekableStream] Entry. URL: ${urlString}, StartTime: ${startTime}, EndTime: ${endTime}, Headers: ${JSON.stringify(httpHeaders)}`);
    
    const meta = { warnings: [] };
    let parsedUrl;
    
    try { 
        console.log(`[DEBUG] [seekableStream] Analisando URL: ${urlString}`);
        parsedUrl = new URL(urlString); 
    } catch (error) { 
        console.error(`[DEBUG] [seekableStream] Erro na análise da URL: ${error.message}`);
        throw new SeekError('INVALID_URL', `URL inválida: ${urlString}`); 
    }
    
    if (!['http:', 'https:', 'file:'].includes(parsedUrl.protocol)) {
        console.error(`[DEBUG] [seekableStream] Protocolo não suportado: ${parsedUrl.protocol}`);
        throw new SeekError('UNSUPPORTED_PROTOCOL', `Protocolo não suportado: ${parsedUrl.protocol}. Apenas http(s) e file:// são suportados.`);
    }

    let contentLength = 0;
    let contentType = 'application/octet-stream';
    let acceptRanges = 'none';

    if (parsedUrl.protocol === 'file:') {
        console.log('[DEBUG] [seekableStream] Lidando com protocolo file:');
        try {
            console.log(`[DEBUG] [seekableStream] Verificando stats do arquivo: ${parsedUrl.pathname}`);
            const stats = await fs.stat(parsedUrl.pathname);
            console.log(`[DEBUG] [seekableStream] Stats do arquivo: Tamanho: ${stats.size}`);
            
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
            
            console.log(`[DEBUG] [seekableStream] Definido contentLength: ${contentLength}, contentType: ${contentType}, acceptRanges: ${acceptRanges}`);
        } catch (error) {
            console.error(`[DEBUG] [seekableStream] Erro de acesso ao arquivo: ${error.message}`);
            throw new SeekError('FILE_ACCESS_ERROR', `Erro ao acessar arquivo local: ${parsedUrl.pathname}. ${error.message}`);
        }
    } else {
        console.log('[DEBUG] [seekableStream] Lidando com protocolo http(s):');
        try {
            console.log('[DEBUG] [seekableStream] Fazendo requisição HEAD...');
            const response = await makeHttpRequest(parsedUrl, { method: 'HEAD', headers: httpHeaders }, customRequestFn);
            
            console.log(`[DEBUG] [seekableStream] Resposta HEAD Status: ${response.statusCode}`);
            console.log(`[DEBUG] [seekableStream] Resposta HEAD Headers: ${JSON.stringify(response.headers)}`);

            if (response.statusCode >= 400) {
                console.error(`[DEBUG] [seekableStream] Erro na requisição HEAD. Status: ${response.statusCode}`);
                throw new SeekError('HTTP_HEAD_ERROR', `Error making HEAD request to ${urlString}: ${response.statusCode} ${response.statusMessage}`);
            }
            
            contentLength = parseInt(response.headers['content-length'], 10) || 0;
            contentType = response.headers['content-type'] || contentType;
            acceptRanges = response.headers['accept-ranges'] || acceptRanges;
            console.log(`[DEBUG] [seekableStream] Do HEAD: contentLength=${contentLength}, contentType=${contentType}, acceptRanges=${acceptRanges}`);

            if (contentType.includes('application/octet-stream')) {
                console.log('[DEBUG] [seekableStream] ContentType é octet-stream. Tentando adivinhar pela extensão.');
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
                console.log(`[DEBUG] [seekableStream] contentType adivinhado: ${contentType}`);

                if (contentType === 'application/octet-stream' && extension === 'webm') {
                    console.log('[DEBUG] [seekableStream] Forçando contentType para audio/webm.');
                    contentType = 'audio/webm';
                }
            }
        } catch (error) {
            console.error(`[DEBUG] [seekableStream] Requisição HEAD falhou: ${error.message}`);
            meta.warnings.push(`Could not retrieve HEAD metadata for ${urlString}. Error: ${error.message}`);
        }
    }

    meta.contentType = contentType;
    meta.contentLength = contentLength;
    meta.acceptRanges = acceptRanges;
    console.log(`[DEBUG] [seekableStream] Meta após HEAD/Stat: ${JSON.stringify(meta)}`);

    const PROBE_BYTES = 512 * 1024;
    let probeData = Buffer.alloc(0);
    console.log(`[DEBUG] [seekableStream] Iniciando probe. PROBE_BYTES: ${PROBE_BYTES}`);

    if (parsedUrl.protocol === 'file:') {
        try {
            console.log('[DEBUG] [seekableStream] Fazendo probe do arquivo local...');
            const fileHandle = await fs.open(parsedUrl.pathname, 'r');
            const buffer = Buffer.alloc(PROBE_BYTES);
            const { bytesRead } = await fileHandle.read(buffer, 0, PROBE_BYTES, 0);
            probeData = buffer.slice(0, bytesRead);
            await fileHandle.close();
            console.log(`[DEBUG] [seekableStream] Probe do arquivo leu ${bytesRead} bytes.`);
        } catch (error) {
            console.error(`[DEBUG] [seekableStream] Erro no probe do arquivo: ${error.message}`);
            throw new SeekError('FILE_PROBE_ERROR', `Erro ao fazer probe do arquivo local: ${parsedUrl.pathname}. ${error.message}`);
        }
    } else if (contentLength > 0 && acceptRanges === 'bytes') {
        try {
            console.log('[DEBUG] [seekableStream] Fazendo probe do recurso HTTP com fetchWithRange...');
            probeData = await fetchWithRange(parsedUrl, 0, Math.min(contentLength - 1, PROBE_BYTES - 1), httpHeaders, customRequestFn);
            console.log(`[DEBUG] [seekableStream] Probe HTTP completo. Obteve ${probeData.length} bytes.`);
        } catch (error) {
            console.error(`[DEBUG] [seekableStream] Erro no probe HTTP: ${error.message}`);
            meta.warnings.push(`HTTP probe error: ${error.message}. Continuing without detailed probe.`);
        }
    } else {
        console.warn('[DEBUG] [seekableStream] Pulando probe (Content-Length desconhecido ou ranges não suportados).');
        meta.warnings.push('Initial probe failed: Unknown Content-Length or byte ranges not supported.');
    }

    if (probeData.length > 0) {
        console.log(`[DEBUG] [seekableStream] Analisando ${probeData.length} bytes de dados do probe...`);
        console.log('[DEBUG] [seekableStream] Carregando libwebm...');
        const libwebm = await createLibWebM();
        let isWebm = false;
        
        try {
            console.log('[DEBUG] [seekableStream] Tentando libwebm.WebMFile.fromBuffer...');
            const webmFile = await libwebm.WebMFile.fromBuffer(probeData, libwebm._module);
            isWebm = true;
            console.log('[DEBUG] [seekableStream] libwebm parse SUCESSO. Arquivo é WebM.');

            meta.durationMs = webmFile.getDuration() * 1000; // Convert seconds to milliseconds
            console.log(`[DEBUG] [seekableStream] libwebm duração: ${meta.durationMs}ms`);

            let audioTrackInfo = null;
            for (let i = 0; i < webmFile.getTrackCount(); i++) {
                const trackInfo = webmFile.getTrackInfo(i);
                if (trackInfo.trackType === libwebm.WebMTrackType.AUDIO) {
                    audioTrackInfo = trackInfo;
                    break;
                }
            }

            if (audioTrackInfo) {
                console.log(`[DEBUG] [seekableStream] libwebm encontrou trilha de áudio. CodecID: ${audioTrackInfo.codecId}`);
                let detectedMime = meta.contentType;
                if (audioTrackInfo.codecId === 'A_OPUS') {
                    detectedMime = 'audio/opus';
                } else if (audioTrackInfo.codecId === 'A_VORBIS') {
                    detectedMime = 'audio/vorbis';
                }
                meta.contentType = detectedMime;

                meta.codec = {
                    container: 'webm',
                    mime: detectedMime,
                    codecName: audioTrackInfo.codecId,
                    codecPrivate: null
                };
                console.log(`[DEBUG] [seekableStream] libwebm meta atualizado: ${JSON.stringify(meta.codec)}`);
            } else {
                console.warn('[DEBUG] [seekableStream] libwebm: Arquivo WebM encontrado, mas nenhuma trilha de áudio detectada.');
                meta.warnings.push('WebM file found, but no audio track detected.');
            }
        } catch (error) {
            console.warn(`[DEBUG] [seekableStream] libwebm parse FALHOU: ${error.message}.`);
            meta.warnings.push(`Error parsing probeData as WebM with @sctg/libwebm-js: ${error.message}. Attempting CodecParser.`);
            isWebm = false;
        }

        if (!isWebm) {
            console.log('[DEBUG] [seekableStream] Não é WebM (ou parse falhou). Tentando CodecParser...');
            try {
                const parser = new CodecParser(contentType);
                console.log(`[DEBUG] [seekableStream] CodecParser inicializado com tipo: ${contentType}`);
                
                const parsedFrames = parser.parseAll(probeData);
                console.log(`[DEBUG] [seekableStream] CodecParser encontrou ${parsedFrames.length} frames.`);

                if (parsedFrames.length > 0 && parser.codec) {
                    console.log(`[DEBUG] [seekableStream] CodecParser SUCESSO. Codec: ${parser.codec}`);
                    meta.codec = {
                        container: parser.codec === 'mpeg' ? 'mp3' : parser.codec,
                        mime: meta.contentType,
                        codecName: parser.codec
                    };
                    if (meta.contentType.startsWith('application/ogg')) {
                        console.log('[DEBUG] [seekableStream] Corrigindo contentType de application/ogg para audio/*');
                        meta.contentType = `audio/${parser.codec}`;
                        meta.codec.mime = meta.contentType;
                    }
                    console.log(`[DEBUG] [seekableStream] CodecParser definiu meta.codec: ${JSON.stringify(meta.codec)}`);
                } else {
                    console.warn('[DEBUG] [seekableStream] CodecParser não encontrou frames ou codec.');
                    meta.codec = undefined;
                }
            } catch (error) {
                console.error(`[DEBUG] [seekableStream] CodecParser FALHOU: ${error.message}`);
                meta.warnings.push(`Error parsing probeData with codec-parser: ${error.message}`);
            }
        }
    }

    let startByte = 0;
    let endByte = contentLength > 0 ? contentLength - 1 : Infinity;
    let effectiveDurationMs = meta.durationMs;
    
    console.log('[DEBUG] [seekableStream] Calculando byte ranges...');

    if (!effectiveDurationMs && meta.contentLength > 0) {
        console.log('[DEBUG] [seekableStream] Nenhuma duração encontrada. Estimando duração...');
        const estimatedBitrateKbps = estimateBitrate(meta.contentLength, 0, meta.contentType);
        console.log(`[DEBUG] [seekableStream] Bitrate estimado: ${estimatedBitrateKbps} kbps`);
        effectiveDurationMs = (meta.contentLength * 8) / (estimatedBitrateKbps * 1000) * 1000;
        console.log(`[DEBUG] [seekableStream] Duração estimada: ${effectiveDurationMs} ms`);
    }

    if (effectiveDurationMs > 0 && !meta.durationMs) {
        console.log(`[DEBUG] [seekableStream] Definindo meta.durationMs para a duração efetiva/estimada: ${effectiveDurationMs}`);
        meta.durationMs = effectiveDurationMs;
    }

    if (acceptRanges === 'bytes' && contentLength > 0 && effectiveDurationMs > 0) {
        console.log('[DEBUG] [seekableStream] Calculando bytes de seek a partir do tempo...');
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
            console.warn(`[DEBUG] [seekableStream] Range de bytes inválido calculado (start ${startByte} > end ${endByte}). Corrigindo para ir até o final.`);
            endByte = contentLength > 0 ? contentLength - 1 : Infinity;
        }
    } else if (startTime !== undefined || (endTime !== undefined && endTime !== null)) {
        console.warn('[DEBUG] [seekableStream] Não é possível fazer seek (sem suporte a range, contentLength ou duração). Ignorando tempos.');
        meta.warnings.push('Server does not support byte ranges or unknown Content-Length. Full streaming will be attempted, ignoring startTime/endTime.');
    }

    meta.resolvedRange = { start: startByte, end: endByte };
    console.log(`[DEBUG] [seekableStream] Final resolvedRange: ${JSON.stringify(meta.resolvedRange)}`);
    console.log(`[DEBUG] [seekableStream] Verificando remux WebM. Codec: ${meta.codec?.container}, startByte: ${startByte}`);

    if (meta.codec && meta.codec.container === 'webm' && startByte > 0) {
        console.log('[DEBUG] [seekableStream] ENTRANDO na lógica de Remux WebM.');
        const { PassThrough, Readable } = await import('stream');
        const finalStream = new PassThrough();

        const HEADER_PROBE_BYTES = 65535;
        console.log(`[DEBUG] [seekableStream] Buscando header (Bytes: 0-${HEADER_PROBE_BYTES - 1})...`);
        
        let headerBuffer;
        if (parsedUrl.protocol === 'file:') {
            const fileHandle = await fs.open(parsedUrl.pathname, 'r');
            const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
            const { bytesRead } = await fileHandle.read(buffer, 0, HEADER_PROBE_BYTES, 0);
            headerBuffer = buffer.slice(0, bytesRead);
            await fileHandle.close();
        } else {
            headerBuffer = await fetchWithRange(parsedUrl, 0, HEADER_PROBE_BYTES - 1, httpHeaders, customRequestFn);
        }
        console.log(`[DEBUG] [seekableStream] Buffer de header buscado, tamanho: ${headerBuffer.length}`);

        console.log(`[DEBUG] [seekableStream] Buscando fragmento (Bytes: ${startByte} - ${endByte})...`);
        let fragmentBuffer;
        if (parsedUrl.protocol === 'file:') {
            const fileHandle = await fs.open(parsedUrl.pathname, 'r');
            const bufferSize = endByte === Infinity ? contentLength - startByte : endByte - startByte + 1;
            
            if (bufferSize > 0) {
                console.log(`[DEBUG] [seekableStream] Lendo ${bufferSize} bytes do arquivo a partir de ${startByte}`);
                const buffer = Buffer.alloc(bufferSize);
                const { bytesRead } = await fileHandle.read(buffer, 0, bufferSize, startByte);
                fragmentBuffer = buffer.slice(0, bytesRead);
            } else {
                console.warn(`[DEBUG] [seekableStream] Tamanho do buffer do fragmento é 0 ou negativo (${bufferSize}).`);
                fragmentBuffer = Buffer.alloc(0);
            }
            await fileHandle.close();
        } else {
            fragmentBuffer = await fetchWithRange(parsedUrl, startByte, endByte, httpHeaders, customRequestFn);
        }
        console.log(`[DEBUG] [seekableStream] Buffer de fragmento buscado, tamanho: ${fragmentBuffer.length}`);

        console.log('[DEBUG] [seekableStream] Carregando libwebm para remuxing...');
        const libwebm = await createLibWebM();
        
        const finalWebmBuffer = await (async () => {
            try {
                console.log('[DEBUG] [seekableStream] Remux: Combinando buffers...');
                const combinedBuffer = Buffer.concat([headerBuffer, fragmentBuffer]);
                console.log(`[DEBUG] [seekableStream] Remux: Buffer combinado, tamanho: ${combinedBuffer.length}`);

                console.log('[DEBUG] [seekableStream] Remux: Analisando buffer combinado...');
                const parsedFile = await libwebm.WebMFile.fromBuffer(combinedBuffer, libwebm._module);
                
                console.log('[DEBUG] [seekableStream] Remux: Criando writer...');
                const writerFile = libwebm.WebMFile.forWriting(libwebm._module);

                const trackMapping = {};
                console.log(`[DEBUG] [seekableStream] Remux: Mapeando ${parsedFile.getTrackCount()} trilhas...`);
                for (let i = 0; i < parsedFile.getTrackCount(); i++) {
                    const trackInfo = parsedFile.getTrackInfo(i);
                    let newTrackId;
                    if (trackInfo.trackType === libwebm.WebMTrackType.VIDEO) {
                        console.log(`[DEBUG] [seekableStream] Remux: Mapeando trilha de VÍDEO ${trackInfo.trackNumber}`);
                        const videoInfo = parsedFile.parser.getVideoInfo(trackInfo.trackNumber);
                        newTrackId = writerFile.addVideoTrack(videoInfo.width, videoInfo.height, trackInfo.codecId);
                        trackMapping[trackInfo.trackNumber] = { newId: newTrackId, type: 'video' };
                    } else if (trackInfo.trackType === libwebm.WebMTrackType.AUDIO) {
                        console.log(`[DEBUG] [seekableStream] Remux: Mapeando trilha de ÁUDIO ${trackInfo.trackNumber}`);
                        const audioInfo = parsedFile.parser.getAudioInfo(trackInfo.trackNumber);
                        newTrackId = writerFile.addAudioTrack(audioInfo.samplingFrequency, audioInfo.channels, trackInfo.codecId);
                        trackMapping[trackInfo.trackNumber] = { newId: newTrackId, type: 'audio' };
                    }
                }

                console.log('[DEBUG] [seekableStream] Remux: Reescrevendo frames...');
                for (const oldIdStr in trackMapping) {
                    const oldId = parseInt(oldIdStr, 10);
                    const mapping = trackMapping[oldId];
                    console.log(`[DEBUG] [seekableStream] Remux: Reescrevendo frames para trilha ${oldId} (Tipo: ${mapping.type})`);
                    
                    if (mapping.type === 'video') {
                        let frame;
                        while ((frame = parsedFile.parser.readNextVideoFrame(oldId))) {
                            writerFile.writeVideoFrame(mapping.newId, frame.data, frame.timestampNs, frame.isKeyframe);
                        }
                    } else if (mapping.type === 'audio') {
                        let frame;
                        while ((frame = parsedFile.parser.readNextAudioFrame(oldId))) {
                            writerFile.writeAudioFrame(mapping.newId, frame.data, frame.timestampNs);
                        }
                    }
                }
                
                console.log('[DEBUG] [seekableStream] Remux: Finalizando novo buffer WebM...');
                const finalizedBuffer = writerFile.finalize();
                console.log(`[DEBUG] [seekableStream] Remux: Buffer finalizado, tamanho: ${finalizedBuffer.length}`);
                return finalizedBuffer;

            } catch (error) {
                console.error(`[DEBUG] [seekableStream] Remuxing WebM FALHOU: ${error.message}. Voltando para concatenação simples.`);
                meta.warnings.push(`WebM remuxing failed: ${error.message}. Falling back to simple concatenation.`);
                return Buffer.concat([headerBuffer, fragmentBuffer]);
            }
        })();

        console.log(`[DEBUG] [seekableStream] Remux completo. Tamanho final do buffer: ${finalWebmBuffer.length}`);

        const readable = new Readable();
        console.log('[DEBUG] [seekableStream] Inserindo buffer remuxado na nova stream Readable.');
        readable.push(finalWebmBuffer);
        readable.push(null);

        readable.on('error', (err) => {
            console.error('[DEBUG] [seekableStream] Erro na stream Readable remuxada:', err);
            finalStream.emit('error', err);
        });
        readable.pipe(finalStream);

        meta.resolvedRange = {
            start: 0,
            end: finalWebmBuffer.length - 1
        };
        meta.contentLength = finalWebmBuffer.length;
        meta.webmHeaderPrepended = true;
        meta.originalSeekRange = { start: startByte, end: endByte };
        
        console.log(`[DEBUG] [seekableStream] Meta atualizado para stream remuxada: ${JSON.stringify(meta)}`);
        console.log('[DEBUG] [seekableStream] Retornando stream remuxada.');
        return { stream: finalStream, meta };
    }

    console.log('[DEBUG] [seekableStream] Não é WebM ou startByte é 0. Criando stream padrão.');
    let stream;
    if (parsedUrl.protocol === 'file:') {
        console.log('[DEBUG] [seekableStream] Criando local file stream para o range.');
        stream = createLocalFileStream(parsedUrl.pathname, meta.resolvedRange.start, meta.resolvedRange.end);
    } else {
        console.log('[DEBUG] [seekableStream] Criando HTTP stream para o range.');
        stream = createHttpStream(parsedUrl, meta.resolvedRange.start, meta.resolvedRange.end, httpHeaders, customRequestFn);
    }

    console.log('[DEBUG] [seekableStream] Retornando stream padrão.');
    return { stream, meta };
}