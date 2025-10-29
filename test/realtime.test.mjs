import assert from 'assert';
import { seekableStream } from '../src/index.js';
import { Readable } from 'stream';
import prism from 'prism-media';

// --- CONFIGURAÇÃO DE TESTE ---
const TEST_URL = 'https://raw.githubusercontent.com/LunaStream/QuickMedia/refs/heads/main/lab/sample/videoplayback.webm';
const SEEK_TIME_MS = 20000; // 20 segundos

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

        await new Promise((resolve, reject) => {
            pcmStream.on('data', (chunk) => {
                chunksProcessed++;
                totalBytes += chunk.length;
                // Simula uma análise em tempo real
                console.log(`  [Análise em tempo real] Processando chunk #${chunksProcessed}, Tamanho: ${chunk.length} bytes`);
                assert.ok(chunk.length > 0, 'Chunk de áudio PCM está vazio.');
            });

            pcmStream.on('end', () => {
                console.log(`
--- Fim do stream ---`);
                console.log(`  Total de chunks processados: ${chunksProcessed}`);
                console.log(`  Total de bytes de áudio (PCM) recebidos: ${totalBytes}`);
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
