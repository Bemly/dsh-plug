import type {
    DshAgent,
    DshAgentRegistry,
    SessionRecord,
    SessionStatus,
    TokenUsageStats,
} from '../types.js';

export type {
    DshAgent,
    DshAgentRegistry,
    SessionRecord,
    SessionStatus,
    TokenUsageStats,
} from '../types.js';

export interface DshAgentHandle {
    agent: DshAgent;
    dispose?: () => Promise<void> | void;
    [key: string]: unknown;
}

export interface AgentSetup {
    [key: string]: unknown;
}

export interface SessionEventLike {
    type: string;
    seq?: number;
    time?: number;
    data?: any;
    [key: string]: unknown;
}

export interface SessionsService {
    fork?: (session: any) => { events: SessionEventLike[] };
    [key: string]: unknown;
}

export interface AgentPresetsLike {
    resolve?: (id: string) => Promise<{ id: string }>;
    mount?: (ctx: unknown, id: string) => Promise<void>;
    [key: string]: unknown;
}

export interface PresetComposition {
    agentPreset?: string;
    setup?: (ctx: unknown) => Promise<void>;
}
