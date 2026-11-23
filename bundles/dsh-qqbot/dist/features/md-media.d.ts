export interface MdMediaTarget {
    /** 带 token 的官方 API 调用（GroupAdminClient.apiCall 同款签名） */
    apiCall: (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<{
        ok: true;
        data: unknown;
    } | {
        ok: false;
        err: {
            code?: string;
            human?: string;
        };
    }>;
}
export interface MdMediaResult {
    ok: boolean;
    /** 外网 COS 预签名（短时效，仅供测试/预览；不是持久链接） */
    previewUrl?: string;
    url?: string;
    imageId?: string;
    width?: number;
    height?: number;
    bytes?: number;
    cached?: boolean;
    msg?: string;
}
/** 读图片宽高（PNG / GIF / JPEG；webp 暂返回 0） */
export declare function imageSize(buf: Buffer): {
    width: number;
    height: number;
};
/**
 * 上传一张本地图片，返回 `qqbot-media://` 引用串。
 * 先查服务端列表：若已有**同名（含内容指纹）**的图，直接复用，不再占配额。
 */
export declare function uploadMarkdownImage(target: MdMediaTarget, filePath: string): Promise<MdMediaResult>;
/** 查询有效图片列表 */
export declare function listMarkdownImages(target: MdMediaTarget, cursor?: string): Promise<{
    ok: boolean;
    data?: unknown;
    msg?: string;
}>;
/** 删除一张图片（释放配额；已发出的消息不受影响） */
export declare function deleteMarkdownImage(target: MdMediaTarget, imageId: string): Promise<{
    ok: boolean;
    msg?: string;
}>;
//# sourceMappingURL=md-media.d.ts.map