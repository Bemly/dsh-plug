window.__ModuleLoader__.load({
	id: "dsh-whale-tail-plug",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;

		// Single-feature extract from dsh-moe-lite (KurosawaGeeker):
		// 1) plugin-button icon -> whale-tail still, hover plays the wiggle gif;
		// 2) sidebar brand row -> stacked maid crest. No theme CSS, no skin attr,
		// so it runs alongside any active skin without touching its files.
		const ASSET = "/api/whale-tail-plug/assets?f=";

		const CSS = `
			/* ---------- stacked brand: one crest replaces wordmark + HARNESS badge ---------- */
			div[class*="_logoRow"] {
				position: relative;
				height: 80px !important;
				align-items: center;
			}
			button[class*="_brand"] [class*="brandIdentity"] {
				display: none !important;
			}
			button[class*="_brand"] {
				position: static !important;
				overflow: visible;
				min-height: 64px;
			}
			img.dsh-moe-stacked-brand {
				position: absolute;
				left: 50%;
				top: 50%;
				transform: translate(-50%, -50%);
				display: block;
				height: 64px;
				width: auto;
				max-width: none;
				user-select: none;
			}
			/* The collapsed rail swaps back to DSH's native whale mark. The crest
			   is the only lockup now, so the whale goes away in both states. */
			svg[viewBox="0 0 23.16 17.04"] {
				display: none !important;
			}
			/* ---------- brand wordmark in DeepSeek blue ---------- */
			button[class*="brand"],
			svg[viewBox="26 0 156 24"],
			svg[viewBox="0 0 23.16 17.04"] {
				color: #2f6bf0 !important;
			}
			html body[data-ds-dark-theme] button[class*="brand"],
			html body[data-ds-dark-theme] svg[viewBox="26 0 156 24"],
			html body[data-ds-dark-theme] svg[viewBox="0 0 23.16 17.04"] {
				color: #9cc2ff !important;
			}

			/* ---------- whale-tail plugin-button icon ---------- */
			svg[data-moe-plug-icon] {
				width: 20px !important;
				height: 20px !important;
			}
			button[data-moe-plug-hover] {
				position: relative;
			}
			img.dsh-moe-plug-gif {
				position: absolute;
				z-index: 3;
				pointer-events: none;
				object-fit: contain;
			}
			html body[data-ds-dark-theme] img.dsh-moe-plug-gif {
				filter: invert(1) hue-rotate(180deg) saturate(1.6) brightness(1.1);
			}
		`;

		const PLUG_GIF = ASSET + "whale-tail-wiggle.gif";
		const PLUG_FIRST = ASSET + "whale-tail-first.webp";

		function placePlugImg(img, button, svg) {
			const br = button.getBoundingClientRect();
			const r = svg.getBoundingClientRect();
			const size = 22;
			img.style.width = size + "px";
			img.style.height = size + "px";
			img.style.left = (r.left - br.left - (size - r.width) / 2) + "px";
			img.style.top = (r.top - br.top - (size - r.height) / 2) + "px";
		}

		function installPlugIcon(button, svg) {
			let still = button.querySelector(".dsh-moe-plug-still");
			if (!still) {
				still = document.createElement("img");
				still.className = "dsh-moe-plug-gif dsh-moe-plug-still";
				still.alt = "";
				still.decoding = "async";
				still.src = PLUG_FIRST;
				button.append(still);
			}
			placePlugImg(still, button, svg);
			still.style.visibility = button.dataset.moePlugActive === "1" ? "hidden" : "";
			svg.style.visibility = "hidden";

			if (button.dataset.moePlugHover === "1") return;
			button.dataset.moePlugHover = "1";
			button.addEventListener("pointerenter", () => {
				const currentSvg = button.querySelector("svg");
				if (!currentSvg) return;
				let anim = button.querySelector(".dsh-moe-plug-anim");
				if (!anim) {
					anim = document.createElement("img");
					anim.className = "dsh-moe-plug-gif dsh-moe-plug-anim";
					anim.alt = "";
					anim.decoding = "async";
					anim.src = PLUG_GIF;
					button.append(anim);
					placePlugImg(anim, button, currentSvg);
				}
				button.dataset.moePlugActive = "1";
				still.style.visibility = "hidden";
			});
			button.addEventListener("pointerleave", () => {
				delete button.dataset.moePlugActive;
				button.querySelector(".dsh-moe-plug-anim")?.remove();
				still.style.visibility = "";
			});
		}

		function restoreHiddenBrandChildren(root = document) {
			root.querySelectorAll("[data-moe-brand-hidden]").forEach((el) => {
				el.style.display = el.dataset.moeBrandHidden || "";
				delete el.dataset.moeBrandHidden;
			});
		}

		function installStackedBrand(svg) {
			const host = svg.closest("button") || svg.parentElement;
			if (!host) return;
			host.style.position = "relative";
			host.style.overflow = "visible";
			host.querySelectorAll(":scope > .dsh-moe-harness-banner").forEach((img) => img.remove());
			let img = host.querySelector(":scope > .dsh-moe-stacked-brand");
			if (!img) {
				img = document.createElement("img");
				img.className = "dsh-moe-stacked-brand";
				img.alt = "";
				img.decoding = "async";
				img.draggable = false;
				img.src = ASSET + "deepseek-harness-maid-stacked.svg";
				img.addEventListener("error", () => {
					img.remove();
					host.removeAttribute("data-moe-stacked-brand");
					restoreHiddenBrandChildren(host);
				}, { once: true });
				host.append(img);
			}
			host.dataset.moeStackedBrand = "1";
			/* Inline-hide every other child, not only the known identity class:
			   a re-render or a different DSH build must never leave the old
			   wordmark behind the crest. */
			for (const child of [...host.children]) {
				if (child === img) continue;
				if (!child.hasAttribute("data-moe-brand-hidden")) {
					child.dataset.moeBrandHidden = child.style.display || "";
				}
				child.style.display = "none";
			}
		}

		function decorateIcons() {
			document.querySelectorAll("button").forEach((button) => {
				if (!/^(插件|Plugins?)$/i.test(button.getAttribute("aria-label") || "")) return;
				const svg = button.querySelector("svg");
				if (!svg || svg.getAttribute("viewBox") !== "0 0 16 16") return;
				installPlugIcon(button, svg);
			});
			document.querySelectorAll('svg[viewBox="26 0 156 24"]').forEach((svg) => installStackedBrand(svg));
		}

		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.dataset.whaleTailPlug = "decoration";
				style.textContent = CSS;
				document.head.append(style);

				decorateIcons();
				let scheduled = false;
				const observer = new MutationObserver(() => {
					if (scheduled) return;
					scheduled = true;
					requestAnimationFrame(() => {
						scheduled = false;
						decorateIcons();
					});
				});
				observer.observe(document.body, { childList: true, subtree: true });
				const kick = () => decorateIcons();
				const kickTimers = [setTimeout(kick, 300), setTimeout(kick, 1200)];
				const onResize = () => decorateIcons();
				window.addEventListener("resize", onResize);
				return () => {
					observer.disconnect();
					for (const t of kickTimers) clearTimeout(t);
					window.removeEventListener("resize", onResize);
					document.querySelectorAll(".dsh-moe-plug-still,.dsh-moe-plug-anim").forEach((img) => img.remove());
					document.querySelectorAll("button[data-moe-plug-hover]").forEach((button) => {
						delete button.dataset.moePlugHover;
						delete button.dataset.moePlugActive;
						const svg = button.querySelector("svg");
						if (svg) svg.style.visibility = "";
					});
					document.querySelectorAll(".dsh-moe-stacked-brand").forEach((img) => img.remove());
					document.querySelectorAll("[data-moe-stacked-brand]").forEach((host) => host.removeAttribute("data-moe-stacked-brand"));
					restoreHiddenBrandChildren();
					style.remove();
				};
			}, "whale-tail-plug: tail icon + stacked crest");
		}

		exports.apply = apply;
		return module.exports;
	}
});
