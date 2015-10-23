#!/usr/bin/env node

'use strict';

var program = require('commander'),
    completion = require('./completion.js'),
    appstoreActions = require('./appstoreActions.js'),
    actions = require('./actions.js');

// Allow self signed certs!
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
var DEV = process.env.NODE_ENV === 'dev';

program.version('0.0.1');

program.command('completion')
    .description('Shows completion for you shell')
    .action(completion);

program.command('backup')
    .description('Backup app')
    .option('--app <id>', 'App id')
    .action(actions.backup);

program.command('createOAuthAppCredentials')
    .option('--redirect-uri <uri>', 'Redirect Uri')
    .option('--scope [scopes]', 'Scopes (comma separated)', 'profile,roleUser')
    .description('Create oauth app credentials for local development')
    .action(actions.createOAuthAppCredentials);

program.command('build')
    .description('Build an app')
    .option('--no-cache', 'Do not use cache')
    .option('--raw', 'Raw output build log')
    .action(appstoreActions.build);

if (DEV) {
    program.command('buildlog')
        .description('Build logs')
        .option('-f, --tail', 'Tail')
        .action(appstoreActions.buildLogs);
}

program.command('exec [cmd...]')
    .description('Exec a command in application')
    .option('--app <id>', 'App id')
    .action(actions.exec);

program.command('help')
    .description('Show this help')
    .action(function () { program.outputHelp(); });

program.command('info')
    .description('Application info')
    .option('--app <id>', 'App id')
    .action(actions.info);

program.command('inspect')
    .description('Inspect a Cloudron returning raw JSON')
    .action(actions.inspect);

program.command('init')
    .description('Creates a new CloudronManifest.json and Dockerfile')
    .action(actions.init);

program.command('install')
    .description('Install or update app into cloudron')
    .option('-n, --new', 'New installation')
    .option('--select', 'Select a build')
    .option('--wait', 'Wait for healthcheck to succeed')
    .option('-c, --configure', 'Configure installation')
    .option('-l, --location <subdomain>', 'Subdomain location')
    .option('--appstore-id <appid@version>', 'Use app from the store')
    .action(actions.install);

program.command('list')
    .description('List installed applications')
    .action(actions.list);

program.command('login [cloudron]')
    .description('Login to cloudron')
    .option('-u, --username <username>', 'Username')
    .option('-p, --password <password>', 'Password (unsafe)')
    .action(actions.login);

program.command('logout')
    .description('Logout off cloudron')
    .action(actions.logout);

program.command('logs')
    .description('Application logs')
    .option('-f, --tail', 'Follow')
    .option('--app <id>', 'App id')
    .action(actions.logs);

program.command('open')
    .description('Open the app in the Browser')
    .action(actions.open);

program.command('restore')
    .description('Restore app from last known backup')
    .option('--app <id>', 'App id')
    .action(actions.restore);

program.command('restart')
    .description('Restart the installed application')
    .option('--app <id>', 'App id')
    .action(actions.restart);

program.command('publish')
    .description('Publish app to the store')
    .option('-f, --force', 'Update existing version')
    .option('-s, --submit', 'Submit app for review')
    .action(appstoreActions.publish);

program.command('versions')
    .description('List published versions')
    .option('--app <id>', 'App id')
    .option('--apps', 'List all published apps')
    .option('--raw', 'Dump versions as json')
    .action(appstoreActions.listVersions);

program.command('uninstall')
    .description('Uninstall app from cloudron')
    .option('--app <id>', 'App id')
    .action(actions.uninstall);

program.command('unpublish')
    .description('Unpublish app or app version from the store')
    .option('-a, --app <id>', 'Unpublish app')
    .option('-f, --force', 'Do not ask anything')
    .action(appstoreActions.unpublish);

if (!process.argv.slice(2).length) {
    program.outputHelp();
} else { // https://github.com/tj/commander.js/issues/338
    // deal first with global flags!
    program.parse(process.argv);

    var knownCommand = program.commands.some(function (command) { return command._name === process.argv[2]; });
    if (!knownCommand) {
        console.error('Unknown command: ' + process.argv[2]);
        process.exit(1);
    }
    return;
}

program.parse(process.argv);
