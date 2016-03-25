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
    .description('Create, List and Download Backups')
    .option('--app <id>', 'App id')
    .option('--download <id>', 'Download specific backup')
    .option('--list', 'List backups')
    .option('--create', 'Create a backup') // TODO: remove this as default when app tests are fixed
    .action(actions.backup);

program.command('createOAuthAppCredentials')
    .option('--redirect-uri <uri>', 'Redirect Uri')
    .option('--scope [scopes]', 'Scopes (comma separated)', 'profile,roleUser')
    .option('--shell', 'Print shell friendly output')
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
    .option('-t,--tty', 'Allocate tty')
    .option('-i,--interactive', 'Keep STDIN open')
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
    .option('--pretty', 'Pretty print', false)
    .action(actions.inspect);

program.command('init')
    .description('Creates a new CloudronManifest.json and Dockerfile')
    .action(actions.init);

program.command('install')
    .description('Install or update app into cloudron')
    .option('--app <id>', 'App id')
    .option('-n, --new', 'New installation')
    .option('--select', 'Select a build')
    .option('--wait', 'Wait for healthcheck to succeed')
    .option('-c, --configure', 'Configure installation')
    .option('-l, --location <subdomain>', 'Subdomain location')
    .option('--appstore-id <appid@version>', 'Use app from the store')
    .option('-f, --force', 'Force an update')
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
    .option('-l, --lines <lines>', 'Number of lines to show (default: 500)')
    .option('--app <id>', 'App id')
    .action(actions.logs);

program.command('open')
    .description('Open the app in the Browser')
    .action(actions.open);

program.command('pull <remote> <local>')
    .description('pull remote file/dir. Use trailing slash to indicate remote directory.')
    .option('--app <id>', 'App id')
    .action(actions.pull);

program.command('push <local> <remote>')
    .description('push local file')
    .option('--app <id>', 'App id')
    .action(actions.push);

program.command('restore')
    .description('Restore app from last known backup')
    .option('--app <id>', 'App id')
    .action(actions.restore);

program.command('restart')
    .description('Restart the installed application')
    .option('--app <id>', 'App id')
    .action(actions.restart);

program.command('submit')
    .description('Submit app to the store (for review)')
    .action(appstoreActions.submit);

program.command('upload')
    .description('Upload app to the store for testing')
    .option('-f, --force', 'Update existing version')
    .option('--skip-validation', 'Skip Appstore requirements validation', false)
    .action(appstoreActions.upload);

program.command('versions')
    .description('List published versions')
    .option('--app <id>', 'App id')
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

program.command('published')
    .description('List published apps')
    .action(appstoreActions.listPublishedApps);

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
