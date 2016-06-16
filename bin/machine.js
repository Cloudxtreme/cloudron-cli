#!/usr/bin/env node

'use strict';

require('../src/common.js');

var program = require('commander');

program
    .version(require('../package.json').version)
    .command('create', 'Creates a new Cloudron')
    .command('restore', 'Restores a Cloudron')
    .command('backup', 'Manage Cloudron backups');

if (!process.argv.slice(2).length) {
    program.outputHelp();
} else { // https://github.com/tj/commander.js/issues/338
    // deal first with global flags!
    program.parse(process.argv);

    var knownCommand = program.commands.some(function (command) { return command._name === process.argv[2] || command._alias === process.argv[2]; });
    if (!knownCommand) {
        console.error('Unknown command: ' + process.argv[2]);
        process.exit(1);
    }
    return;
}

program.parse(process.argv);
