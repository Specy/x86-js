import { minify } from "terser";
import fs from "fs/promises";
const files = [
    './dist/x86/deps/capstone-x86.min.js',
    './dist/x86/deps/keystone-x86.min.js',
    './dist/x86/deps/unicorn-x86.min.js',
]

const minifyFiles = async () => {
    for (const file of files) {
        const code = await fs.readFile(file, 'utf-8');
        const result = await minify(code, {
            compress: true,
        });
        if (result.error) {
            console.error(`Error minifying ${file}:`, result.error);
        } else {
            fs.writeFile(file, result.code, 'utf-8')
            console.log(`Minified ${file} successfully.`);
        }
    }
};

minifyFiles()