declare module "ollama" {
  export interface GenerateOptions {
    host?: string;
    model: string;
    prompt: string;
    system?: string;
    stream?: boolean;
    options?: Record<string, number>;
  }

  export interface GenerateResponse {
    response: string;
  }

  const client: {
    generate: (options: GenerateOptions) => Promise<GenerateResponse>;
  };

  export default client;
}
