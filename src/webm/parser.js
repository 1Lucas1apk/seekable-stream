class WebmParser {
    constructor() {
    }

    static _vintLength(buffer, offset) {
        if (offset < 0 || offset >= buffer.length) {
            return -1;
        }

        const byte = buffer[offset];

        if ((byte & 0x80) === 0x80) return 1;
        if ((byte & 0xC0) === 0x40) return 2;
        if ((byte & 0xE0) === 0x20) return 3;
        if ((byte & 0xF0) === 0x10) return 4;
        if ((byte & 0xF8) === 0x08) return 5;
        if ((byte & 0xFC) === 0x04) return 6;
        if ((byte & 0xFE) === 0x02) return 7;
        if ((byte & 0xFF) === 0x01) return 8;

        return -1;
    }

    static _expandVint(buffer, start, end) {
        const length = WebmParser._vintLength(buffer, start);
        if (length === -1 || end > buffer.length) return -1;
        
        let value = 0;
        for (let i = start; i < end; i++) {
            value = (value << 8) | buffer[i];
        }
        return value;
    }

    static readEbmlIdVint(buffer, offset) {
        const length = WebmParser._vintLength(buffer, offset);
        if (length === -1) {
            throw new Error("Buffer underflow: Cannot read VINT, offset is beyond buffer length or data is too short.");
        }
        const value = WebmParser._expandVint(buffer, offset, offset + length);
        if (value === -1) {
            throw new Error("Buffer underflow: Cannot read complete VINT.");
        }
        return { value, length };
    }

    static readEbmlSizeVint(buffer, offset) {
        if (offset >= buffer.length) {
            throw new Error("Buffer underflow: Cannot read VINT, offset is beyond buffer length.");
        }

        let length = 1;
        let mask = 0x80;
        let value = buffer[offset];

        while (length <= 8 && !(value & mask)) {
            mask >>= 1;
            length++;
        }

        if (length > 8) {
            throw new Error("Invalid VINT: VINT length exceeds 8 bytes.");
        }
        if (offset + length > buffer.length) {
            throw new Error(`Buffer underflow: Cannot read complete VINT of length ${length} bytes.`);
        }

        value &= ~mask;

        for (let i = 1; i < length; i++) {
            value = (value << 8) | buffer[offset + i];
        }
        return { value, length };
    }

    static readEbmlElement(buffer, offset) {
        const idResult = WebmParser.readEbmlIdVint(buffer, offset);
        const id = idResult.value;
        let currentOffset = offset + idResult.length;

        const sizeResult = WebmParser.readEbmlSizeVint(buffer, currentOffset);
        const size = sizeResult.value;
        currentOffset += sizeResult.length;

        const dataOffset = currentOffset;
        const elementLength = idResult.length + sizeResult.length + size;

        if (offset + elementLength > buffer.length) {
            throw new Error(`Buffer underflow: Cannot read complete EBML element. Expected total length ${elementLength}, but buffer has only ${buffer.length - offset} bytes remaining.`);
        }

        return { id, size, dataOffset, elementLength };
    }

    static *parseEbml(buffer, offset, endOffset) {
        let currentOffset = offset;
        while (currentOffset < endOffset) {
            try {
                const element = WebmParser.readEbmlElement(buffer, currentOffset);
                element.offset = currentOffset;
                yield element;
                currentOffset += element.elementLength;
            } catch (error) {
                break;
            }
        }
    }

    static readEbmlString(buffer, offset, size) {
        return buffer.toString('utf8', offset, offset + size);
    }

    static removeEbmlElement(buffer, elementIdToRemove) {
        const chunks = [];
        let currentOffset = 0;

        for (const element of WebmParser.parseEbml(buffer, 0, buffer.length)) {
            if (element.id === elementIdToRemove) {
                continue;
            }
            if (element.offset > currentOffset) {
                chunks.push(buffer.slice(currentOffset, element.offset));
            }
            chunks.push(buffer.slice(element.offset, element.offset + element.elementLength));
            currentOffset = element.offset + element.elementLength;
        }

        if (currentOffset < buffer.length) {
            chunks.push(buffer.slice(currentOffset, buffer.length));
        }

        return Buffer.concat(chunks);
    }

    static EBML_ID = 0x1A45DFA3;
    static SEGMENT_ID = 0x18538067;
    static DOC_TYPE_ID = 0x4282;
    static INFO_ID = 0x1549A966;
    static TIMECODESCALE_ID = 0x2AD7B1;
    static DURATION_ID = 0x4489;
    static TRACKS_ID = 0x1654AE6B;
    static TRACK_ENTRY_ID = 0xAE;
    static CODEC_ID_ID = 0x86;
    static CODEC_PRIVATE_ID = 0x63A2;
    static CLUSTER_ID = 0x1F43B675;
    static SIMPLE_BLOCK_ID = 0xA3;
    static BLOCK_ID = 0xA1;
    static TIMECODE_ID = 0xE7;
    static CUES_ID = 0x1C53BB6B;
    static SEEK_HEAD_ID = 0x114D9B74;

    static parseWebm(buffer) {
        try {
            let offset = 0;
            let ebmlHeader = null;
            let segment = null;
            const parsedMetadata = {
                duration: null,
                durationFloat: null,
                timecodeScale: 1000000,
            };
            let audioTrack = null;
            let firstClusterOffset = null;

            const ebmlElement = WebmParser.readEbmlElement(buffer, offset);
            if (ebmlElement.id !== WebmParser.EBML_ID) {
                throw new Error("Invalid WebM file: First element is not EBML Header.");
            }
                        ebmlHeader = ebmlElement;
                        offset += ebmlElement.elementLength;
            
                        let segmentFound = false;
                        let currentOffset = offset;

                                    while (currentOffset < buffer.length) {

                                        try {

                                                                const idResult = WebmParser.readEbmlIdVint(buffer, currentOffset);

                                                                const id = idResult.value;

                                                                const idLength = idResult.length;

                                            

                                                                const sizeResult = WebmParser.readEbmlSizeVint(buffer, currentOffset + idLength);

                                const size = sizeResult.value;

                                const sizeLength = sizeResult.length;

            

                                const dataOffset = currentOffset + idLength + sizeLength;

                                const elementLength = idLength + sizeLength + size;

            

                                if (id === WebmParser.SEGMENT_ID) {

                                    segment = { id, size, dataOffset, elementLength, offset: currentOffset };

                                    segmentFound = true;

                                    break;

                                }

                                currentOffset += elementLength;

                            } catch (error) {

                                break;

                            }

                        }

            

                        if (!segmentFound) {

                            throw new Error("Invalid WebM file: Segment element not found.");

                        }

            

                        for (const childElement of WebmParser.parseEbml(buffer, segment.dataOffset, Math.min(segment.dataOffset + segment.size, buffer.length))) {                if (childElement.id === WebmParser.INFO_ID) {
                    for (const infoChild of WebmParser.parseEbml(buffer, childElement.dataOffset, childElement.dataOffset + childElement.size)) {
                        if (infoChild.id === WebmParser.TIMECODESCALE_ID) {
                            parsedMetadata.timecodeScale = buffer.readUIntBE(infoChild.dataOffset, infoChild.size);
                        } else if (infoChild.id === WebmParser.DURATION_ID) {
                            if (infoChild.size === 4) {
                                parsedMetadata.durationFloat = buffer.readFloatBE(infoChild.dataOffset);
                            } else if (infoChild.size === 8) {
                                parsedMetadata.durationFloat = buffer.readDoubleBE(infoChild.dataOffset);
                            }
                        }
                    }
                } else if (childElement.id === WebmParser.TRACKS_ID) {
                    for (const trackEntryElement of WebmParser.parseEbml(buffer, childElement.dataOffset, childElement.dataOffset + childElement.size)) {
                        if (trackEntryElement.id === WebmParser.TRACK_ENTRY_ID) {
                            let trackId = null;
                            let trackType = null;
                            let codecId = null;
                            let codecPrivate = null;

                            for (const trackProperty of WebmParser.parseEbml(buffer, trackEntryElement.dataOffset, trackEntryElement.dataOffset + trackEntryElement.size)) {
                                if (trackProperty.id === 0xD7) {
                                    trackId = buffer.readUIntBE(trackProperty.dataOffset, trackProperty.size);
                                } else if (trackProperty.id === 0x83) {
                                    trackType = buffer.readUIntBE(trackProperty.dataOffset, trackProperty.size);
                                } else if (trackProperty.id === WebmParser.CODEC_ID_ID) {
                                    codecId = WebmParser.readEbmlString(buffer, trackProperty.dataOffset, trackProperty.size);
                                } else if (trackProperty.id === WebmParser.CODEC_PRIVATE_ID) {
                                    codecPrivate = buffer.slice(trackProperty.dataOffset, trackProperty.dataOffset + trackProperty.size);
                                }
                            }

                            if (trackType === 2) {
                                audioTrack = {
                                    id: trackId,
                                    type: trackType,
                                    codecId: codecId,
                                    codecPrivate: codecPrivate
                                };
                            }
                        }
                    }
                } else if (childElement.id === WebmParser.CLUSTER_ID) {
                    if (firstClusterOffset === null) {
                        firstClusterOffset = childElement.offset;
                    }
                }
            }

            if (parsedMetadata.durationFloat && parsedMetadata.timecodeScale) {
                parsedMetadata.duration = (parsedMetadata.durationFloat * parsedMetadata.timecodeScale) / 1000000;
            }

            const metadata = {
                duration: parsedMetadata.duration,
            };

            return { ebmlHeader, segment, metadata, audioTrack, firstClusterOffset };
        } catch (e) {
            throw e;
        }
    }
    static updateDuration(buffer, newDurationMs, timecodeScale) {
        const newDurationFloat = (newDurationMs * 1000000) / timecodeScale;

        const chunks = [];
        let currentOffset = 0;

        for (const element of WebmParser.parseEbml(buffer, 0, buffer.length)) {
            if (element.id === WebmParser.INFO_ID) {
                let infoBuffer = buffer.slice(element.dataOffset, element.dataOffset + element.size);
                let infoChunks = [];
                let infoCurrentOffset = 0;
                let durationFound = false;

                for (const infoChild of WebmParser.parseEbml(infoBuffer, 0, infoBuffer.length)) {
                    if (infoChild.id === WebmParser.DURATION_ID) {
                        infoChunks.push(infoBuffer.slice(infoCurrentOffset, infoChild.offset));

                        const newDurationBytes = Buffer.alloc(8);
                        newDurationBytes.writeDoubleBE(newDurationFloat, 0);

                        const newDurationElement = Buffer.concat([
                            Buffer.from([0x44, 0x89]),
                            WebmParser.writeEbmlSize(newDurationBytes.length),
                            newDurationBytes
                        ]);
                        infoChunks.push(newDurationElement);
                        infoCurrentOffset = infoChild.offset + infoChild.elementLength;
                        durationFound = true;
                    } else {
                        infoChunks.push(infoBuffer.slice(infoCurrentOffset, infoChild.offset + infoChild.elementLength));
                        infoCurrentOffset = infoChild.offset + infoChild.elementLength;
                    }
                }

                if (!durationFound) {
                    infoChunks.push(infoBuffer.slice(infoCurrentOffset, infoBuffer.length));

                    const newDurationBytes = Buffer.alloc(8);
                    newDurationBytes.writeDoubleBE(newDurationFloat, 0);

                    const newDurationElement = Buffer.concat([
                        Buffer.from([0x44, 0x89]),
                        WebmParser.writeEbmlSize(newDurationBytes.length),
                        newDurationBytes
                    ]);
                    infoChunks.push(newDurationElement);
                }

                const newInfoData = Buffer.concat(infoChunks);

                chunks.push(buffer.slice(currentOffset, element.offset));
                chunks.push(Buffer.concat([
                    Buffer.from([0x15, 0x49, 0xA9, 0x66]),
                    WebmParser.writeEbmlSize(newInfoData.length),
                    newInfoData
                ]));
                currentOffset = element.offset + element.elementLength;

            } else {
                chunks.push(buffer.slice(currentOffset, element.offset + element.elementLength));
                currentOffset = element.offset + element.elementLength;
            }
        }

        if (currentOffset < buffer.length) {
            chunks.push(buffer.slice(currentOffset, buffer.length));
        }

        return Buffer.concat(chunks);
    }

    static writeEbmlSize(size) {
        if (size < 0x7F) {
            return Buffer.from([0x80 | size]);
        } else if (size < 0x3FFF) {
            return Buffer.from([0x40 | (size >> 8), size & 0xFF]);
        } else if (size < 0x1FFFFF) {
            return Buffer.from([0x20 | (size >> 16), (size >> 8) & 0xFF, size & 0xFF]);
        } else if (size < 0xFFFFFFF) {
            return Buffer.from([0x10 | (size >> 24), (size >> 16) & 0xFF, (size >> 8) & 0xFF, size & 0xFF]);
        }
        throw new Error('EBML size too large to write.');
    }

}

export default WebmParser;