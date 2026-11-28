import type { ContentBlock } from '@deepseek-ai/dsh-llm';

export declare const MAX_AGGREGATE_IMAGES = 100;

export interface AggregateCandidate {
    key?: string;
    path: string;
    sender: string;
    url?: string;
}

export interface AggImage {
    key?: string;
    path: string;
    url?: string;
    sender: string;
    at: number;
    sent: boolean;
    img: unknown;
    w: number;
    h: number;
    buf: Uint8Array;
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    fp: string;
    dhash?: string;
    fileid?: string;
}

export declare function initAggregateRegistry(dataRoot: string): void;
export declare function noteOurAttachment(id: string): void;
export declare function isOurAttachment(id: unknown): boolean;

type ImageProbe = (agent: unknown) => Promise<boolean | undefined>;
type ImageSaver = (data: Uint8Array, mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif') => Promise<{
    attachment: unknown;
    width?: number;
    height?: number;
} | undefined>;

export declare function setImageAggregateHooks(hooks: {
    probeImageInput?: ImageProbe;
    saveImage?: ImageSaver;
}): void;

export declare function prepareAggregateImages(items: AggregateCandidate[], logger?: {
    warn?: (message: string) => void;
}): Promise<AggImage[]>;

export declare function pushPreparedAggImage(key: string, item: AggImage | undefined): number;
export declare function pushAggImage(key: string, path: string, sender: string, url?: string): Promise<number>;
export declare function pendingAggImages(key: string): AggImage[];
export declare function markAggSent(items: AggImage[]): void;
export declare function rememberAggSentPaths(key: string, items: Array<AggImage | string>): void;
export declare function clearAggImages(key: string): void;

export declare function stitchAggImages(items: AggImage[]): Promise<{
    data: Uint8Array;
    width: number;
    height: number;
    used: AggImage[];
    layout: string;
} | undefined>;

export declare function buildAggregateBlocks(key: string, agent: unknown, logger?: {
    debug?: (message: string) => void;
    warn?: (message: string) => void;
}): Promise<ContentBlock[]>;
