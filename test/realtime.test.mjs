import assert from 'assert';
import { seekableStream } from '../src/index.js';
import { Readable } from 'stream';
import prism from 'prism-media';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

// --- CONFIGURAÇÃO DE TESTE ---
const TEST_URL = 'https://raw.githubusercontent.com/LunaStream/QuickMedia/refs/heads/main/lab/sample/videoplayback.webm';
const SEEK_TIME_MS = 20000; // 20 segundos
const TEST_DIR = path.resolve('./test');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

function createWavHeader(dataLength, sampleRate, channels, bitDepth = 16) {
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    const byteRate = sampleRate * channels * (bitDepth / 8);
    buffer.writeUInt32LE(byteRate, 28);
    const blockAlign = channels * (bitDepth / 8);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);
    return buffer;
}

async function validateFileWithFFmpeg(filePath) {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -v error -i "${filePath}" -f null -`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`FFmpeg validation failed for ${filePath}: ${error.message}\n${stderr}`));
      } else {
        console.log(`  ✓ [FFmpeg] Validação de ${filePath} com sucesso.`);
        resolve(true);
      }
    });
  });
}

async function runRealtimeTest() {
    console.log(`--- Iniciando teste de streaming em tempo real com seek em ${SEEK_TIME_MS}ms ---`);

    try {
        const { stream, meta } = await seekableStream(TEST_URL, SEEK_TIME_MS);

        assert.ok(stream instanceof Readable, 'A saída de seekableStream não é um Readable stream.');
        console.log('  ✓ [Sucesso] seekableStream retornou um stream Readable.');

        assert.strictEqual(meta.codec.container, 'webm', 'O container do codec não é webm.');
        assert.ok(meta.webmHeaderPrepended, 'O cabeçalho WebM não foi pré-anexado para o seek.');
        console.log('  ✓ [Sucesso] Metadados para o stream com seek estão corretos.');

        const demuxer = new prism.opus.WebmDemuxer();
        const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });

        const pcmStream = stream.pipe(demuxer).pipe(decoder);

        let chunksProcessed = 0;
        let totalBytes = 0;
        const pcmChunks = [];

        await new Promise((resolve, reject) => {
            pcmStream.on('data', (chunk) => {
                chunksProcessed++;
                totalBytes += chunk.length;
                pcmChunks.push(chunk);
                // Simula uma análise em tempo real
                console.log(`  [Análise em tempo real] Processando chunk #${chunksProcessed}, Tamanho: ${chunk.length} bytes`);
                assert.ok(chunk.length > 0, 'Chunk de áudio PCM está vazio.');
            });

            pcmStream.on('end', async () => {
                console.log(`
--- Fim do stream ---`);
                console.log(`  Total de chunks processados: ${chunksProcessed}`);
                console.log(`  Total de bytes de áudio (PCM) recebidos: ${totalBytes}`);

                if (totalBytes > 0) {
                    const pcmData = Buffer.concat(pcmChunks);
                    const outputFilePath = path.join(TEST_DIR, 'realtime_test_output.wav');
                    const header = createWavHeader(pcmData.length, 48000, 2, 16); // Assumindo 48kHz, 2 canais, 16-bit
                    const wavData = Buffer.concat([header, pcmData]);
                    fs.writeFileSync(outputFilePath, wavData);
                    console.log(`  ✓ [Sucesso] Porção do stream PCM salvo em ${outputFilePath} (${wavData.length} bytes)`);
                    try {
                        await validateFileWithFFmpeg(outputFilePath);
                    } catch (ffmpegErr) {
                        console.error(`  ✗ [Falha] Validação FFmpeg do arquivo WAV em tempo real falhou:`, ffmpegErr.message);
                        // Não falha o teste principal, mas registra o erro
                    }
                }
                resolve();
            });

            pcmStream.on('error', (err) => {
                console.error('Erro no pipeline de streaming do Prism:', err);
                reject(err);
            });

            stream.on('error', (err) => {
                console.error('Erro no seekableStream:', err);
                reject(err);
            });
        });

        assert.ok(chunksProcessed > 0, 'Nenhum chunk de áudio foi processado.');
        assert.ok(totalBytes > 0, 'Nenhum byte de áudio foi recebido.');
        console.log('\n  ✓ [Sucesso] Teste de streaming em tempo real concluído com sucesso!');

    } catch (error) {
        console.error('\n  ✗ [Falha] O teste de streaming em tempo real falhou:', error);
        process.exit(1);
    }
}

runRealtimeTest();
