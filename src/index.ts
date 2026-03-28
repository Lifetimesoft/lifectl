#!/usr/bin/env node

import {Command} from "commander";
import {authCommand} from "./commands/auth.js";
import {createRequire} from "module";

const require = createRequire(import.meta.url);
const {version} = require("../package.json");

const program = new Command();

program
    .name("lifectl")
    .description("LifetimeSoft CLI")
    .version(`lifectl v${version} (LifetimeSoft)`);

program.addCommand(authCommand);

program.parse();