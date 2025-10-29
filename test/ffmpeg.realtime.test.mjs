import assert from 'assert';
import { spawn } from 'child_process';
import { seekableStream } from '../src/index.js';
import { Readable } from 'stream';
import path from 'path';
import fs from 'fs';

// --- CONFIGURAÇÃO DE TESTE ---
const TEST_URL = 'https://raw.githubusercontent.com/LunaStream/QuickMedia/refs/heads/main/lab/sample/videoplayback.webm';
const SEEK_TIME_MS = 30000; // 30 segundos
const TEST_DIR = path.resolve('./test');

// Configurar o log para um arquivo
const LOG_FILE = path.join(TEST_DIR, 'ffmpeg_test_output.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });

function log(...args) {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
  console.log(message);
  logStream.write(message + '\n');
}

async function runFFmpegTest() {
    log(`--- Iniciando teste de streaming em tempo real com FFmpeg (Seek: ${SEEK_TIME_MS}ms) ---`);

    try {
        const { stream, meta } = await seekableStream(TEST_URL, SEEK_TIME_MS);

        assert.ok(stream instanceof Readable, 'A saída de seekableStream não é um Readable stream.');
        log('  ✓ [Sucesso] seekableStream retornou um stream Readable.');

        assert.strictEqual(meta.codec.container, 'webm', 'O container do codec não é webm.');
        assert.ok(meta.webmHeaderPrepended, 'O cabeçalho WebM não foi pré-anexado para o seek.');
        log('  ✓ [Sucesso] Metadados para o stream com seek estão corretos.');

        const ffmpegProcess = spawn('ffmpeg', [
            '-v', 'info',      // Nível de log para mais detalhes
            '-i', 'pipe:0',     // Entrada do stdin
            '-f', 'null',       // Formato de saída nulo (apenas validação)
            '-'                 // Saída para stdout (que será ignorado)
        ]);

        log(`  -> FFmpeg iniciado com PID: ${ffmpegProcess.pid}`);

        // Pipe do stream para o stdin do FFmpeg
        stream.pipe(ffmpegProcess.stdin);

        // Gerenciamento de erros e logs
        let ffmpegLogs = '';
        ffmpegProcess.stderr.on('data', (data) => {
            const logLine = data.toString();
            ffmpegLogs += logLine;
            log(`  [FFMPEG STDERR]: ${logLine.trim()}`);
        });

        stream.on('error', (err) => {
            log('  ✗ [ERRO] Erro no seekableStream:', err);
            ffmpegProcess.kill(); // Mata o processo FFmpeg se o stream falhar
        });

        ffmpegProcess.stdin.on('error', (err) => {
            // Ignora erros de 'EPIPE' que podem acontecer se o ffmpeg fechar antes do stream
            if (err.code === 'EPIPE') {
                log('  [AVISO] FFmpeg stdin fechou antes do stream (EPIPE). Isso pode ser normal.');
                return;
            }
            log('  ✗ [ERRO] Erro no stdin do FFmpeg:', err);
        });

        // Aguarda o processo do FFmpeg terminar
        const exitCode = await new Promise((resolve) => {
            ffmpegProcess.on('close', (code) => {
                log(`  -> Processo FFmpeg finalizado com código de saída: ${code}`);
                resolve(code);
            });
        });

        assert.strictEqual(exitCode, 0, `FFmpeg finalizou com erro (código: ${exitCode}). Verifique os logs.`);
        
        // Verifica se o FFmpeg detectou a duração correta (ou algo próximo)
        const durationMatch = ffmpegLogs.match(/Duration: (\d{2}:\d{2}:\d{2}\.\d{2})/);
        if (durationMatch) {
            log(`  ✓ [FFMPEG] Duração detectada: ${durationMatch[1]}`);
        } else {
            log('  ? [AVISO] Não foi possível verificar a duração nos logs do FFmpeg.');
        }

        log('\n  ✓ [Sucesso] Teste de streaming em tempo real com FFmpeg concluído com sucesso!');
        logStream.end(() => process.exit(0));

    } catch (error) {
        log('\n  ✗ [FALHA] O teste de streaming em tempo real com FFmpeg falhou:', error);
        logStream.end(() => process.exit(1));
    }
}

runFFmpegTest();
