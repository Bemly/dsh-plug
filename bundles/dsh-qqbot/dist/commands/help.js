import { readFileSync } from 'node:fs';
import { sendMarkdownChunked } from '../shared/index.js';
/** 从包根 package.json 读版本：原来写死 v0.1.0，升到 2.x 后一直显示错版本。 */
const PKG_VERSION = (() => {
    try {
        return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || 'unknown';
    }
    catch {
        return 'unknown';
    }
})();
/** /bot-help — 查看所有指令以及用途 */
export function helpCommand({ config }, allCommands) {
    return {
        name: 'bot-help',
        description: '查看所有指令以及用途',
        handler: async (cmdCtx) => {
            const lines = ['### QQBot插件内置指令', ''];
            for (const cmd of allCommands()) {
                const name = Array.isArray(cmd.name) ? cmd.name[0] : cmd.name;
                if (cmd.hidden)
                    continue;
                lines.push(`<qqbot-cmd-input text="/${name}" show="/${name}"/> ${cmd.description ?? ''}`);
            }
            lines.push('', `> dsh-qqbot v${PKG_VERSION}`);
            await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
            return { kind: 'noop' };
        },
    };
}
//# sourceMappingURL=help.js.map