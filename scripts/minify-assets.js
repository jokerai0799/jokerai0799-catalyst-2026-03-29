const { build, transform } = require('esbuild');
const fs = require('fs/promises');
const path = require('path');

const root = path.resolve(__dirname, '..');

async function minifyCss(inputRelative, outputRelative) {
  const inputPath = path.join(root, inputRelative);
  const outputPath = path.join(root, outputRelative);
  const source = await fs.readFile(inputPath, 'utf8');
  const result = await transform(source, {
    loader: 'css',
    minify: true,
    legalComments: 'none',
  });
  await fs.writeFile(outputPath, result.code);
}

async function run() {
  await Promise.all([
    minifyCss('shared-assets/ud-styles.css', 'shared-assets/ud-styles.min.css'),
    minifyCss('shared-assets/resources.css', 'shared-assets/resources.min.css'),
    minifyCss('landing-page/assets/css/lineicons.css', 'landing-page/assets/css/lineicons.min.css'),
    build({
      entryPoints: [path.join(root, 'shared-assets/js/main.js')],
      outfile: path.join(root, 'shared-assets/js/main.min.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2020'],
      minify: true,
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'silent',
    }),
  ]);

  console.log('Minified CSS and JS assets written, including LineIcons.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
