import {execSync} from 'child_process';
import {join} from 'path'
import {platform} from "node:os";

const arch = process.argv[2];


["keystone", "capstone", "unicorn"].forEach((dir) => {
    const cwd = join(__dirname,"../src/x86", dir);
    console.log(`Building ${dir} in ${cwd}...`);

    const gruntCmd = platform() === "win32"
        ? join(cwd, "node_modules/.bin/grunt.cmd")
        : join(cwd, "node_modules/.bin/grunt");

    execSync(`${gruntCmd} build`, { stdio: "inherit", cwd });
});