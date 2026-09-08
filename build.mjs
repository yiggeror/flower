// -----------------------------------------------------------------------------
// build.mjs — 把整个项目打包成 单个 HTML 文件（dist/flower.html）。
// 双击即可运行，不需要服务器、不需要联网。
//   node build.mjs
// -----------------------------------------------------------------------------
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

// 把裸模块名解析到本地内置的 three
const threeResolver = {
  name: 'three-resolver',
  setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({
      path: resolve(root, 'vendor/three/three.module.js'),
    }));
    build.onResolve({ filter: /^three\/addons\// }, (args) => ({
      path: resolve(root, 'vendor/three/examples/jsm', args.path.replace('three/addons/', '')),
    }));
  },
};

const result = await esbuild.build({
  entryPoints: [resolve(root, 'src/main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  plugins: [threeResolver],
  write: false,
});

const js = result.outputFiles[0].text;

let html = readFileSync(resolve(root, 'index.html'), 'utf8');
// 去掉 importmap 与外部模块引用，换成内联的整包
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
// 注意：必须用函数式替换。压缩后的代码里含有 `$&` 这类序列，
// 若作为字符串传入 String.replace 会被当成"插入匹配到的内容"，把原标签又塞回去。
html = html.replace(
  /<script type="module" src="\.\/src\/main\.js"><\/script>/,
  () => '<script>\n' + js.replace(/<\/script/gi, '<\\/script') + '\n</script>',
);

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/flower.html'), html);
console.log('dist/flower.html  ' + (Buffer.byteLength(html) / 1024 / 1024).toFixed(2) + ' MB');

// Artifact 版：页面骨架由平台注入，这里只保留 title / style / 内容 / 脚本
let art = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*$/i, '')
  .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '')
  .replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '')
  .replace(/<meta[^>]*>\s*/gi, '')
  .replace(/<link rel="icon"[\s\S]*?\/>\s*/i, '')
  .trim();
writeFileSync(resolve(root, 'dist/flower-artifact.html'), art);
console.log('dist/flower-artifact.html  ' + (Buffer.byteLength(art) / 1024 / 1024).toFixed(2) + ' MB');
