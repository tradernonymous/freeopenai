/**
 * Bundled by jsDelivr using Rollup v4.62.2 and esbuild v0.28.1.
 * Original file: /npm/ts-dedent@2.3.0/esm/index.js
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
function d(i){for(var f=[],c=1;c<arguments.length;c++)f[c-1]=arguments[c];var n=Array.from(typeof i=="string"?[i]:i);n[n.length-1]=n[n.length-1].replace(/\r?\n([\t ]*)$/,"");var s=n.reduce(function(t,u){var a=u.match(/\n([\t ]+|(?!\s).)/g);return a?t.concat(a.map(function(g){var r,e;return(e=(r=g.match(/[\t ]/g))===null||r===void 0?void 0:r.length)!==null&&e!==void 0?e:0})):t},[]);if(s.length){var h=new RegExp(`
[	 ]{`.concat(Math.min.apply(Math,s),"}"),"g");n=n.map(function(t){return t.replace(h,`
`)})}n[0]=n[0].replace(/^\r?\n/,"");var o=n[0];return f.forEach(function(t,u){var a=o.match(/(?:^|\n)( *)$/),g=a?a[1]:"",r=t;typeof t=="string"&&t.includes(`
`)&&(r=String(t).split(`
`).map(function(e,l){return l===0?e:"".concat(g).concat(e)}).join(`
`)),o+=r+n[u+1]}),o}export{d as dedent,d as default};
//# sourceMappingURL=/sm/c348ce37365aa8905e3465899d658d83813158ddb6fe52c6c1f399537379b909.map