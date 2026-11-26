export declare function isGroupUserBlocked(config: unknown, message: unknown): boolean;
export declare function updateGroupBlocklist(config: any, openid: string, blocked: boolean): {
    ok: boolean;
    reason?: string;
    list?: string[];
};
