declare module "wav" {
  import { Writable } from "node:stream";

  interface FileWriterOptions {
    channels?: number;
    sampleRate?: number;
    bitDepth?: number;
    bitsPerSample?: number;
    dataLength?: number;
  }

  class FileWriter extends Writable {
    constructor(path: string, options?: FileWriterOptions);
  }

  const wav: {
    FileWriter: typeof FileWriter;
  };

  export = wav;
}
