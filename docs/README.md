# seekable-stream

`seekable-stream` is a JavaScript/Node.js library that provides an efficient way to create seekable audio streams from HTTP(S) URLs or local files. It supports byte-range seeking, and for WebM files, it can rewrite the header to reflect the duration of the requested segment, allowing precise seeking in players that rely on duration metadata.

## Installation

```bash
npm install seekable-stream
```

## Usage

### `seekableStream(urlString, startTime, endTime, httpHeaders, customRequestFn)`

Creates a seekable audio stream.

-   `urlString` (string): The URL of the audio resource (HTTP/HTTPS) or the path to a local file (`file://`).
-   `startTime` (number, optional): The desired start time in milliseconds. If omitted, the stream starts from the beginning.
-   `endTime` (number, optional): The desired end time in milliseconds. If omitted or `0`, the stream goes until the end of the file.
-   `httpHeaders` (object, optional): An object containing custom HTTP headers to be sent with requests. E.g., `{ 'Authorization': 'Bearer your_token' }`.
-   `customRequestFn` (function, optional): A custom function to handle HTTP requests. If provided, this function will be used instead of the internal HTTP request logic. It should accept `(url, options)` where `url` is a `URL` object and `options` is an object containing `method` (e.g., 'HEAD', 'GET') and `headers`. It must return a `Promise` that resolves to an `http.IncomingMessage` (for HEAD requests) or a `Readable` stream (for GET requests). For GET requests with a `Range` header, it should return a `Readable` stream. For GET requests without a `Range` header (e.g., for `fetchWithRange` to get `probeData`), it should return a `Promise<Buffer>`.

Returns an object `{ stream: Readable, meta: object }`, where:
-   `stream` is a Node.js `Readable` stream containing the audio data.
-   `meta` is an object containing metadata about the stream, such as `contentType`, `contentLength`, `acceptRanges`, `durationMs`, `webmHeaderPrepended` (if applicable), and `resolvedRange` (the effectively requested byte range).

### Example

```javascript
import { seekableStream } from 'seekable-stream';
import fs from 'fs';
import http from 'http'; // Import http for customRequestFn example
import https from 'https'; // Import https for customRequestFn example

async function main() {
    const url = 'https://www.example.com/audio.mp3';
    const localFilePath = 'file:///path/to/your/audio.flac';

    // Custom request function example
    const myCustomRequestFn = (url, options) => {
        console.log(`Custom request for ${url.href} with method ${options.method}`);
        // You can add custom logic here, e.g., proxy, authentication, etc.
        return new Promise((resolve, reject) => {
            const client = url.protocol === 'http:' ? http : https;
            const req = client.request(url, options, (res) => resolve(res));
            req.on('error', reject);
            req.end();
        });
    };

    // Example 1: Full stream of an MP3 with custom headers and custom request function
    try {
        const { stream, meta } = await seekableStream(url, undefined, undefined, { 'User-Agent': 'MyCustomPlayer/1.0' }, myCustomRequestFn);
        console.log('MP3 stream meta:', meta);
        stream.pipe(fs.createWriteStream('output.mp3'));
        stream.on('end', () => console.log('Full MP3 saved.'));
        stream.on('error', (err) => console.error('MP3 stream error:', err));
    } catch (error) {
        console.error('Error creating MP3 stream:', error);
    }

    // Example 2: Stream of a 10-second WebM segment (from 5s to 15s)
    try {
        const webmUrl = 'https://raw.githubusercontent.com/LunaStream/QuickMedia/refs/heads/main/lab/sample/videoplayback.webm';
        const { stream, meta } = await seekableStream(webmUrl, 5000, 15000); // From 5 seconds to 15 seconds
        console.log('WebM stream meta:', meta);
        stream.pipe(fs.createWriteStream('output_range.webm'));
        stream.on('end', () => console.log('WebM range saved.'));
        stream.on('error', (err) => console.error('WebM stream error:', err));
    } catch (error) {
        console.error('Error creating WebM stream with range:', error);
    }

    // Example 3: Stream from a local file
    try {
        const { stream, meta } = await seekableStream(localFilePath, 0, 30000); // First 30 seconds
        console.log('Local stream meta:', meta);
        stream.pipe(fs.createWriteStream('output_local.flac'));
        stream.on('end', () => console.log('Local file range saved.'));
        stream.on('error', (err) => console.error('Local stream error:', err));
    } catch (error) {
        console.error('Error creating local stream:', error);
    }
}

main();
```

## Error Handling

The library throws `SeekError` instances for specific errors, such as invalid URLs, unsupported protocols, or file/HTTP access issues.

```javascript
try {
    await seekableStream('invalid-url');
} catch (error) {
    if (error.name === 'SeekError') {
        console.error(`SeekError (${error.code}): ${error.message}`);
    } else {
        console.error('Unexpected error:', error);
    }
}
```

## Contribution

Feel free to open issues or pull requests in the project repository.