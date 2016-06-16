#!/usr/bin/env node

'use strict';

require('supererror');

var program = require('commander'),
    actions = require('../src/machine/actions.js');

// Allow self signed certs!
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

program.version(require('../package.json').version);

program.command('create')
    .description('Creates a Cloudron')
    .option('--release [version]', 'Cloudron release version.', 'latest')
    .option('--type <type>', 'Instance type')
    .option('--key <key>', 'SSH key name')
    .option('--domain <domain>', 'Domain eg. cloudron.io')
    .option('--subnet <subnet>', 'Subnet id')
    .option('--security-group <securityGroup>', 'Security group id')
    .action(actions.create);

program.option('--region <region>', 'AWS region');
program.option('--access-key-id <accessKeyId>', 'AWS accessKeyId');
program.option('--secret-access-key <secretAccessKey>', 'AWS secretAccessKey');
program.option('--backup-bucket <backupBucket>', 'S3 backupBucket');

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
