import assert from 'assert';
import { seekableStream } from '../src/index.js';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';

// --- CONFIGURAÇÃO DE TESTE ---
const TEST_DIR = path.resolve('./test');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

// Configurar o log para um arquivo
const LOG_FILE = path.join(TEST_DIR, 'test_output.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args) => {
  originalConsoleLog(...args);
  logStream.write(args.join(' ') + '\n');
};
console.error = (...args) => {
  originalConsoleError(...args);
  logStream.write('ERROR: ' + args.join(' ') + '\n');
};

// --- ARQUIVOS DE TESTE ---
const TEST_FILES = [
  {
    name: 'MP3',
    url: 'https://www.learningcontainer.com/wp-content/uploads/2020/02/Kalimba.mp3',
    expectedContentType: 'audio/mpeg',
    fileName: 'test.mp3'
  },
  {
    name: 'AAC',
    url: 'https://filesamples.com/samples/audio/aac/sample1.aac',
    expectedContentType: 'audio/aac',
    fileName: 'test.aac'
  },
  {
    name: 'FLAC',
    url: 'https://www.learningcontainer.com/wp-content/uploads/2020/02/Sample-FLAC-File.flac',
    expectedContentType: 'audio/flac',
    fileName: 'test.flac'
  },
  
  
    {
      name: 'WebM Opus',
      url: 'https://raw.githubusercontent.com/LunaStream/QuickMedia/refs/heads/main/lab/sample/videoplayback.webm',
      expectedContentType: 'audio/opus',
      fileName: 'test.webm'
    }
];

// --- FUNÇÃO PRINCIPAL DE TESTE ---
async function runTests() {
  console.log('Iniciando testes de integração para seekableStream...');
  let allTestsPassed = true;

  // Limpar arquivos de teste antigos
  TEST_FILES.forEach(file => {
    const filePath = path.join(TEST_DIR, file.fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  // --- Teste de URL inválida ---
  try {
    await assert.rejects(
      () => seekableStream('invalid-url-string', 0, 1000),
      (err) => {
        assert.strictEqual(err.name, 'SeekError');
        assert.strictEqual(err.code, 'INVALID_URL');
        console.log('  ✓ [Sucesso] Deve lançar SeekError para URL inválida');
        return true;
      }
    );
  } catch (err) {
    console.error('  ✗ [Falha] Teste de URL inválida:', err.message);
    allTestsPassed = false;
  }

  // --- Testes de formato de áudio ---
  for (const file of TEST_FILES) {
    try {
      console.log(`\n--- Testando ${file.name} ---`);
      const { stream, meta } = await seekableStream(file.url);

      assert.ok(stream instanceof Readable, `Stream para ${file.name} não é um Readable`);
      console.log(`[DEBUG] meta.contentType: ${meta.contentType}`);
      console.log(`[DEBUG] file.expectedContentType: ${file.expectedContentType}`);
      assert.strictEqual(meta.contentType, file.expectedContentType, `Content-Type para ${file.name} incorreto`);
      
      if (file.name !== 'AAC') {
        assert.ok(meta.contentLength > 0, `Content-Length para ${file.name} é 0 ou indefinido`);
      }

      let totalBytes = 0;
      const outputFilePath = path.join(TEST_DIR, file.fileName);
      const receivedChunks = [];

      await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
            totalBytes += chunk.length;
            receivedChunks.push(chunk);
        });
        stream.on('end', () => {
            console.log(`[DEBUG] Buffer.concat(receivedChunks) first chunk: ${Buffer.concat(receivedChunks).slice(0, 10).toString('hex')}`);
            fs.writeFileSync(outputFilePath, Buffer.concat(receivedChunks));
            resolve();
        });
        stream.on('error', (err) => {
            reject(err);
        });
      });

      assert.ok(totalBytes > 0, `Nenhum byte recebido para ${file.name}`);
      console.log(`  ✓ [Sucesso] Stream ${file.name} salvo em ${outputFilePath} (${totalBytes} bytes)`);

    } catch (err) {
      console.error(`  ✗ [Falha] Teste para ${file.name}:`, err.message);
      allTestsPassed = false;
    }
  }

  // --- Teste de seek (range) para MP3 ---
  try {
    console.log(`\n--- Testando MP3 com seek (range) ---`);
    const { stream, meta } = await seekableStream(TEST_FILES[0].url, 5000, 10000);

    assert.ok(stream instanceof Readable, 'Stream para MP3 range não é um Readable');
    assert.ok(meta.resolvedRange.start > 0, 'Offset inicial para MP3 range não foi aplicado');

    let totalBytes = 0;
    const outputFilePath = path.join(TEST_DIR, 'test_range.mp3');
    const ws = fs.createWriteStream(outputFilePath);

    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => { totalBytes += chunk.length; ws.write(chunk); });
      stream.on('end', () => { ws.end(); resolve(); });
      stream.on('error', (err) => { ws.end(); reject(err); });
      ws.on('error', reject);
    });

    assert.ok(totalBytes > 0, 'Nenhum byte recebido para MP3 range');
    console.log(`  ✓ [Sucesso] Stream MP3 range salvo em ${outputFilePath} (${totalBytes} bytes)`);

  } catch (err) {
    console.error(`  ✗ [Falha] Teste para MP3 com range:`, err.message);
    allTestsPassed = false;
  }

  // --- Teste de seek (range) para WebM ---
  try {
    console.log(`\n--- Testando WebM com seek (range) ---`);
    const { stream, meta } = await seekableStream(TEST_FILES[3].url, 10000); // TEST_FILES[3] is WebM

    assert.ok(stream instanceof Readable, 'Stream para WebM range não é um Readable');
    assert.ok(meta.webmHeaderPrepended === true, 'meta.webmHeaderPrepended deve ser true');
    console.log('[DEBUG] meta.resolvedRange at assertion:', meta.resolvedRange);
    assert.ok(meta.resolvedRange.start === 0, 'Offset inicial para WebM range deve ser 0 (cabeçalho prepended)');

    let receivedBuffer = Buffer.alloc(0);
    let totalBytes = 0;

    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => {
        receivedBuffer = Buffer.concat([receivedBuffer, chunk]);
        totalBytes += chunk.length;
      });
      stream.on('end', () => {
        resolve();
      });
      stream.on('error', (err) => {
        reject(err);
      });
    });

    assert.ok(receivedBuffer.length > 0, 'Nenhum byte recebido para WebM range');
    // Verificar se o buffer recebido começa com o ID EBML (0x1A45DFA3)
    const ebmlId = receivedBuffer.readUInt32BE(0);
    assert.strictEqual(ebmlId, 0x1A45DFA3, `Buffer recebido do WebM range não começa com o ID EBML. Encontrado: 0x${ebmlId.toString(16)}`);

    fs.writeFileSync(path.join(TEST_DIR, 'test_range.webm'), receivedBuffer);
    assert.ok(totalBytes > 0, 'Nenhum byte recebido para WebM range');
    console.log(`  ✓ [Sucesso] Stream WebM range validado com cabeçalho EBML (${totalBytes} bytes)`);

  } catch (err) {
    console.error(`  ✗ [Falha] Teste para WebM com range:`, err.message);
    allTestsPassed = false;
  }


  console.log('\nTestes concluídos.');
  logStream.end(() => {
    if (!allTestsPassed) {
      originalConsoleError('\nAlguns testes falharam. Verifique o arquivo de log para detalhes:', LOG_FILE);
      process.exit(1);
    } else {
      originalConsoleLog('\nTodos os testes passaram com sucesso. Verifique o arquivo de log para detalhes:', LOG_FILE);
      process.exit(0);
    }
  });
}

runTests();