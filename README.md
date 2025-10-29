# seekable-stream

A powerful Node.js library to create a seekable, chunked HTTP stream for remote audio files. It intelligently handles byte-range requests to start streaming from any point in the audio, and for WebM files, it performs on-the-fly remuxing to ensure a valid, playable stream even when seeking.

## Features

-   **Time-based Seeking**: Start streaming from a specific timestamp (in milliseconds).
-   **Chunked Streaming**: Fetches content in small, manageable chunks, ideal for production servers and efficient memory usage.
-   **WebM/Opus Seeking**: Automatically remuxes WebM container headers to provide a valid stream when seeking.
-   **Metadata Detection**: Probes the file to determine container, codec, duration, and content length.
-   **Wide Format Support**: Works with MP3, WebM (Opus/Vorbis), AAC, and FLAC.
-   **Resilient**: Handles servers that don't support range requests gracefully.

## Installation

```bash
npm install seekable-stream
```

## Basic Usage

```javascript
import { seekableStream } from 'seekable-stream';

async function getFullStream() {
    const url = 'https://www.learningcontainer.com/wp-content/uploads/2020/02/Kalimba.mp3';
    
    try {
        const { stream, meta } = await seekableStream(url);
        
        console.log('Stream metadata:', meta);
        
        // Now you can pipe the stream to a speaker, a file, or a processing library.
        // For example, saving it to a file:
        // import fs from 'fs';
        // stream.pipe(fs.createWriteStream('audio.mp3'));
        
        stream.on('data', (chunk) => {
            console.log(`Received chunk of size: ${chunk.length}`);
        });

        stream.on('end', () => {
            console.log('Stream finished.');
        });

    } catch (error) {
        console.error('Error getting stream:', error);
    }
}

getFullStream();
```

## Advanced Usage

### 1. Seeking in an MP3 file

This example shows how to start streaming an MP3 file from the 30-second mark.

```javascript
import { seekableStream } from 'seekable-stream';
import fs from 'fs';

async function seekInMP3() {
    const url = 'https://www.learningcontainer.com/wp-content/uploads/2020/02/Kalimba.mp3';
    const startTimeMs = 30000; // Start at 30 seconds

    try {
        const { stream, meta } = await seekableStream(url, startTimeMs);

        console.log('Streaming MP3 from 30s mark...');
        console.log('Metadata:', meta);

        // Pipe the partial stream to a file
        const writer = fs.createWriteStream('partial_audio.mp3');
        stream.pipe(writer);

        writer.on('finish', () => {
            console.log('Partial MP3 stream saved to partial_audio.mp3');
        });

    } catch (error) {
        console.error('Error seeking in MP3:', error);
    }
}

seekInMP3();
```

### 2. Real-time Processing of a WebM/Opus Stream with Prism-Media

This example demonstrates seeking to 20 seconds in a WebM/Opus file and decoding the audio to raw PCM chunks in real-time using `prism-media`. This is useful for applications like music bots.

```javascript
import { seekableStream } from 'seekable-stream';
import prism from 'prism-media';

async function processWebM() {
    const url = 'https://raw.githubusercontent.com/LunaStream/QuickMedia/refs/heads/main/lab/sample/videoplayback.webm';
    const startTimeMs = 20000; // Start at 20 seconds

    try {
        const { stream, meta } = await seekableStream(url, startTimeMs);

        console.log('Streaming WebM from 20s mark...');
        console.log('Metadata:', meta);

        // Setup prism-media pipeline to decode WebM/Opus to raw PCM
        const demuxer = new prism.opus.WebmDemuxer();
        const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });

        const pcmStream = stream.pipe(demuxer).pipe(decoder);

        let chunksProcessed = 0;
        pcmStream.on('data', (chunk) => {
            chunksProcessed++;
            // Here you can process the raw PCM audio chunk
            console.log(`[Real-time] Processing PCM audio chunk #${chunksProcessed}, Size: ${chunk.length} bytes`);
        });

        pcmStream.on('end', () => {
            console.log(`\nStream finished. Total PCM chunks processed: ${chunksProcessed}`);
        });

    } catch (error) {
        console.error('Error processing WebM stream:', error);
    }
}

processWebM();
```

## API Reference

`seekableStream(urlString, startTime, endTime, httpHeaders)`

-   `urlString` (string, required): The URL of the audio file. Supports `http:`, `https:`, and `file:`.
-   `startTime` (number, optional): The time in milliseconds to start streaming from. Defaults to `0`.
-   `endTime` (number, optional): The time in milliseconds to stop streaming. Defaults to the end of the file.
-   `httpHeaders` (object, optional): Custom headers to send with the HTTP requests (e.g., for authentication).

**Returns:** `Promise<{ stream, meta }>`

An object containing:
-   `stream`: A Node.js `Readable` stream with the audio data.
-   `meta`: An object with metadata about the stream and file.
    -   `contentType` (string): The MIME type of the content (e.g., `audio/mpeg`).
    -   `contentLength` (number): The total size of the file in bytes.
    -   `durationMs` (number): The total duration of the audio in milliseconds (can be estimated).
    -   `acceptRanges` (string): Indicates if the server supports byte ranges.
    -   `codec` (object): Information about the detected audio codec.
        -   `container` (string): e.g., `mp3`, `webm`.
        -   `codecName` (string): e.g., `A_OPUS`, `flac`.
    -   `resolvedRange` (object): The final byte range being streamed (`{ start, end }`).
    -   `webmHeaderPrepended` (boolean): `true` if the stream is a remuxed WebM stream.
    -   `warnings` (Array<string>): An array of any non-fatal warnings that occurred.

## Supported Formats

The library is designed to work with common web audio formats and has specific support for:
-   **MP3** (`audio/mpeg`)
-   **WebM** (`audio/webm`, with Opus or Vorbis codecs)
-   **Ogg** (`application/ogg`, with Opus or Vorbis codecs)
-   **AAC** (`audio/aac`)
-   **FLAC** (`audio/flac`)