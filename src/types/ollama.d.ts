declare module "ollama" {
  export interface ClientConfig {
    host?: string;
    headers?: Record<string, string>;
  }

  export interface GenerateOptions {
    model: string;
    prompt: string;
    system?: string;
    stream?: boolean;
    options?: Record<string, number>;
  }

  export interface GenerateResponse {
    response: string;
  }

  export class Ollama {
    constructor(config?: ClientConfig);
    generate: (options: GenerateOptions) => Promise<GenerateResponse>;
  }

  const client: Ollama;

  export default client;
}
