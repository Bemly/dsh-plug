// dsh-zako-hub — host half: the installer bundle itself carries no UI.
// Use `zako-hub install` to decrypt the bundled payload and register it
// with the current profile via the dsh CLI.
export const name = 'dsh-zako-hub';

export async function apply(ctx) {
  ctx.effect(() => () => {}, 'dsh-zako-hub: installer bundle');
}
