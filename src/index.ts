#!/usr/bin/env node

import {Command} from "commander";
import {authCommand} from "./commands/auth.js";

const program = new Command();

program
    .name("lifectl")
    .description("LifetimeSoft CLI")
    .version("0.1.0");

program.addCommand(authCommand);

program.parse();