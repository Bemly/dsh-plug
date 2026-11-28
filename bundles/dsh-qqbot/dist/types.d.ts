export type ChatScope = 'group' | 'c2c';

export interface Logger {
    debug?: (...args: any[]) => void;
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
}

export interface ReplyTarget {
    scope: ChatScope;
    targetId: string;
    msgId?: string;
    [key: string]: unknown;
}

export interface RawAttachment {
    url?: string;
    filename?: string;
    content_type?: string;
    type?: string;
    [key: string]: unknown;
}

export interface ModelRoute {
    provider: string;
    model: string;
    effort?: string;
    [key: string]: unknown;
}

export interface ModelEntry {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    input?: string[];
    reasoningEfforts?: Record<string, string | null>;
    [key: string]: unknown;
}

export interface TokenUsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    [key: string]: number;
}

export type SessionStatus = 'idle' | 'running' | string;

export interface DshAgent {
    session: any;
    options?: any;
    status?: SessionStatus;
    cancel?: (reason?: unknown) => void;
    inject?: (message: unknown, ...args: any[]) => void;
    steer?: (message: unknown, ...args: any[]) => void;
    [key: string]: any;
}

export interface DshAgentRegistry {
    create?: (input: any) => Promise<any>;
    [key: string]: any;
}

export interface SessionRecord {
    sessionId: string;
    agent: DshAgent;
    handle: any;
    agentPreset?: string;
    lastActivity?: number;
    replyTarget?: ReplyTarget;
    outboundCancels?: Set<() => void>;
    [key: string]: any;
}
