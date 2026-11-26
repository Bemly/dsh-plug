export interface SemanticEmbedder {
    model: string;
    available(): boolean;
    status(): { available: boolean; mode?: string; model?: string; endpoint?: string; reason?: string };
    embedQuery(text: string): Promise<number[] | undefined>;
    embedPassages(texts: string[]): Promise<number[][] | undefined>;
    scoreValue(args: {
        text: string;
        samples: Array<{ m: string; y: number }>;
        sampleKey?: string;
        minScore?: number;
        k?: number;
        weightPow?: number;
    }): Promise<{ score: number; worth: boolean; confidence: number; lowConfidence: boolean; top: Array<{ m: string; y: number; s: number }> } | undefined>;
    warmup(): void;
    reset(): void;
}
export declare function setRagServiceResolver(resolver: () => unknown): void;
export declare function createSemanticEmbedder(opts?: { logger?: { warn?(message: string): void }; enabled?: boolean }): SemanticEmbedder;
