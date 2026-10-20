/**
 * Page styles. The DSH web shell ships no utility CSS for third-party bundles, so the
 * page carries its own sheet, keyed to the shell's `--dsw-*` design tokens.
 */
export const AGENTS_CSS = `
.dta-root{display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dta-head{display:flex;align-items:flex-start;gap:12px;padding:4px 0 16px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dta-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.dta-title{font-size:16px;font-weight:500;line-height:24px}
.dta-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dta-actions{display:flex;gap:8px;flex:none;flex-wrap:wrap;align-items:center}
.dta-row{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dta-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dta-name{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.dta-name-text{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dta-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dta-empty{padding:48px 16px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.dta-banner{margin-top:12px;padding:8px 12px;border-radius:var(--dsw-radius-md,8px);font-size:12px;line-height:18px;background:var(--dsw-alias-fill-tsp-secondary);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.dta-banner[data-tone=error]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.dta-banner[data-tone=ok]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.dta-back{display:flex;align-items:center;gap:8px;padding:4px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dta-back .dta-title{flex:1;min-width:0}
.dta-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dta-field-label{font-size:14px;line-height:22px}
.dta-input,.dta-textarea{box-sizing:border-box;width:100%;min-width:0;border:none;outline:none;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;padding:7px 12px}
.dta-input:disabled,.dta-textarea:disabled{opacity:.6}
.dta-textarea{min-height:96px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:20px}
.dta-textarea-tall{min-height:240px}
.dta-input:focus,.dta-textarea:focus{box-shadow:0 0 0 1px var(--dsw-alias-border-l4,var(--dsw-alias-border-l2))}
.dta-input::placeholder,.dta-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.dta-models{display:flex;flex-direction:column;gap:8px}
.dta-model{display:flex;align-items:center;gap:8px}
.dta-model .dta-input{flex:1}
.dta-window-row{display:flex;align-items:center;gap:8px}
.dta-window-row .dta-input{flex:1;min-width:0}
.dta-chip{flex:none;border:none;cursor:pointer;border-radius:999px;padding:4px 10px;font:inherit;font-size:12px;line-height:18px;background:var(--dsw-alias-fill-tsp-secondary);color:var(--dsw-alias-label-secondary)}
.dta-chip[data-active=true]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-module-platform)}
.dta-chip:disabled{opacity:.5;cursor:default}
.dta-usage{display:flex;flex-direction:column;gap:8px;margin-top:4px;padding:12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform)}
.dta-usage-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dta-usage-total{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dta-usage-bar{display:flex;height:8px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-fill-tsp-secondary)}
.dta-usage-bar span{display:block;height:100%}
.dta-usage-legend{display:flex;flex-wrap:wrap;gap:8px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dta-usage-legend span{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.dta-usage-legend i{width:8px;height:8px;border-radius:2px;flex:none}
.dta-context-view{box-sizing:border-box;width:100%;max-width:760px;margin:0 auto;padding:0 24px 180px}
.dta-section-label{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:13px;line-height:20px;font-weight:500}
.dta-inline-label{flex:none;white-space:nowrap;min-width:56px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dta-window-row .dta-input.dta-input-narrow{flex:none;width:88px}
.dta-window-actions{justify-content:flex-end}
.dta-footnote{margin-top:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}

.dta-context-card{display:flex;flex-direction:column;gap:10px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dta-context-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.dta-footer{display:flex;justify-content:flex-end;gap:8px;padding-top:16px}
`
