/**
 * Bundled by jsDelivr using Rollup v4.62.2 and esbuild v0.28.1.
 * Original file: /npm/mermaid@12.0.0/dist/chunks/mermaid.core/sizeCapture-INFHLROL.mjs
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
var l=Object.defineProperty,r=(n,o)=>l(n,"name",{value:o,configurable:!0}),m=1;function i(){if(!(typeof globalThis>"u"))return globalThis}r(i,"getCaptureGlobal");function u(){return!!i()?.mermaidCaptureSizes}r(u,"shouldCaptureSizes");function d(){return typeof location>"u"?"browser-dev":`${location.pathname}${location.search}`}r(d,"capturedFromLocation");function s(n,o){const t=i();if(!t)return;const e=o.node(),p=((e&&"ownerSVGElement"in e?e.ownerSVGElement:null)??e)?.id??"(unknown)";t.mermaidCapturedSizes??=[];const a={svgId:p,sizes:n};t.mermaidCapturedSizes.push(a),t.mermaidLastCapturedSizes=a}r(s,"emitCapturedSizes");function c(n,o){const t=[];for(const e of o.nodes)e.isGroup||t.push({id:e.id,width:e.width??0,height:e.height??0});t.length!==0&&s({metadata:{captureVersion:m,capturedAt:new Date().toISOString(),capturedFrom:d()},nodes:t},n)}r(c,"captureNodeSizes");export{c as captureNodeSizes,u as shouldCaptureSizes};
//# sourceMappingURL=/sm/7b4b8f8f20bfa8c1e1868fe06c4d3a064e59fc609a81accdbfb3e4e6127fa7cc.map