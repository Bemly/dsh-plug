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
				align-items: center;
			}
			/* The lockup sits in the brandIdentity span; the wrapper around it is
			   a <button> on the Web UI but a <span> in the desktop shell, so the
			   rule may not hang off a tag. */
			[class*="brandIdentity"] {
				display: none !important;
			}
			/* No wrapper rule here: the crest is hosted by the logo row and the
			   wrapper's position is set inline by installStackedBrand. */
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
				pointer-events: none;
			}
			/* 0.2.2's collapsed rail rests as DSH's whale mark and only reveals
			   the panel icon on hover, so the mark has to stay: hide the copy
			   that lives inside the brand lockup only, not the rail's. */
			[class*="_brand"] svg[viewBox="0 0 23.16 17.04"] {
				display: none !important;
			}
			/* ---------- brand wordmark in DeepSeek blue ---------- */
			[class*="_brand"],
			svg[viewBox="26 0 156 24"],
			svg[viewBox="0 0 23.16 17.04"] {
				color: #2f6bf0 !important;
			}
			html body[data-ds-dark-theme] [class*="_brand"],
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
				const currentSvg = findPluginGlyph(button) || button.querySelector("svg");
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

		/* The Plugins panel row. Its label is localized, so it is only a last
		   resort; the pinwheel glyph below identifies the row in any locale. */
		const PLUGIN_LABEL = /^(插件|扩展|扩展程序|外挂|擴充|外掛|Plugins?|Extensions?|プラグイン|Complementos|Erweiterungen|Расширения)$/i;

		/* The pinwheel glyph of the Plugins panel row. Since 0.2.2 product icons
		   are sprite references carrying only `data-icon`, so the artwork is no
		   longer identifiable by its viewBox; older builds inline a 16×16 svg. */
		function findPluginGlyph(button) {
			for (const svg of button.querySelectorAll("svg")) {
				const dataIcon = svg.getAttribute("data-icon") || "";
				if (/^dsw-icon-plugin-pinwheel/i.test(dataIcon)) return svg;
			}
			return null;
		}

		function installStackedBrand(anchor) {
			/* The lockup is a brandIdentity span inside a wrapper that is a
			   <button> on the Web UI but a <span> in the macOS desktop shell,
			   so neither the tag nor `closest("button")` identifies the surface.
			   Anchor the crest on the logo row (present in every build) and
			   hide only the identity element: hiding the row's other children
			   would take the sidebar toggle with it. 0.2.2 renders the brand as
			   text, so the wordmark svg is only the legacy anchor. */
			const identity = anchor.closest('[class*="brandIdentity"]') || anchor.closest('[class*="_brand"]') || anchor;
			const host = identity.closest('div[class*="_logoRow"]') || identity.parentElement;
			if (!host) return;

			const hidden = identity;
			if (!hidden.hasAttribute("data-moe-brand-hidden")) {
				hidden.dataset.moeBrandHidden = hidden.style.display || "";
			}
			hidden.style.display = "none";

			host.style.position = "relative";
			host.style.overflow = "visible";
			/* The lockup is 64px tall; expand the 60px row while the crest is
			   mounted only, so the collapsed rail keeps its own 36px height. */
			host.style.height = "80px";
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
					host.style.height = "";
					hidden.style.display = hidden.dataset.moeBrandHidden || "";
					delete hidden.dataset.moeBrandHidden;
				}, { once: true });
				host.append(img);
			}
			host.dataset.moeStackedBrand = "1";
		}

		/* The crest belongs to the expanded lockup: collapsing the sidebar
		   unmounts the brand wrapper but leaves the logo row (and anything we
		   appended to it) in place, so drop the crest and the row height we
		   raised; the rail's own 36px layout then applies again. */
		function pruneStackedBrand() {
			document.querySelectorAll("img.dsh-moe-stacked-brand").forEach((img) => {
				const host = img.parentElement;
				if (host && (host.querySelector('[class*="brandIdentity"]') || host.querySelector('[class*="_brand"]') || host.querySelector('svg[viewBox="26 0 156 24"]'))) return;
				img.remove();
				if (!host) return;
				host.removeAttribute("data-moe-stacked-brand");
				host.style.height = "";
			});
		}

		/* The brand lockup moved between builds: 0.2.1 drew the DSH wordmark as
		   an inline svg, 0.2.2 renders text inside a `brandIdentity` span. Scan
		   the logo row for either and fall back to the wordmark selector. */
		function installBrandCrests() {
			const rows = document.querySelectorAll('div[class*="_logoRow"]');
			if (rows.length === 0) {
				document.querySelectorAll('svg[viewBox="26 0 156 24"]').forEach((svg) => installStackedBrand(svg));
				return;
			}
			rows.forEach((row) => {
				const identity = row.querySelector('[class*="brandIdentity"]') || row.querySelector('[class*="_brand"]');
				if (identity) installStackedBrand(identity);
			});
		}

		function decorateIcons() {
			pruneStackedBrand();
			document.querySelectorAll("button").forEach((button) => {
				const label = (button.getAttribute("aria-label") || "").trim();
				const glyph = findPluginGlyph(button);
				/* 0.2.2 ships the pinwheel as a sprite reference (`data-icon`, no
				   viewBox); 0.2.1 and older inline it as a 16×16 svg. Accept
				   either, and keep the localized label as the last resort. */
				if (!glyph && !PLUGIN_LABEL.test(label)) return;
				const svg = glyph || button.querySelector('svg[viewBox="0 0 16 16"]') || button.querySelector("svg");
				if (!svg) return;
				installPlugIcon(button, svg);
			});
			installBrandCrests();
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
						button.querySelectorAll("svg").forEach((svg) => {
							svg.style.visibility = "";
						});
					});
					document.querySelectorAll(".dsh-moe-stacked-brand").forEach((img) => img.remove());
					document.querySelectorAll("[data-moe-stacked-brand]").forEach((host) => {
						host.removeAttribute("data-moe-stacked-brand");
						host.style.height = "";
					});
					restoreHiddenBrandChildren();
					style.remove();
				};
			}, "whale-tail-plug: tail icon + stacked crest");
		}

		exports.apply = apply;
		return module.exports;
	}
});
