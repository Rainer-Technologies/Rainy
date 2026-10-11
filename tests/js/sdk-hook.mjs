// Lets Node resolve `@rainy/lightshow` the way the import map in index.html does,
// so an environment package's own tests can import its modules:
//   node --import ./tests/js/sdk-hook.mjs --test packages/*/tests/*.mjs
import module from 'node:module';

const sdk = new URL('../../static/js/lightshow/sdk.js', import.meta.url).href;

module.registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === '@rainy/lightshow') return { url: sdk, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
