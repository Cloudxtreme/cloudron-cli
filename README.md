# The Cloudron CLI tool

The [Cloudron](https://cloudron.io) CLI tool allows you to install, configure and test apps on your Cloudron.
It is also used to submit your app to the Cloudron Store. The `machine` subcommand can be used for
various maintenance tasks on a selfhosted Cloudron.

Read the [http://cloudron.io/documentation.html](Cloudron.io documentation) for in-depth information.

## Installation

Installing the CLI tool requires [node.js](https://nodejs.org/) and
[npm](https://www.npmjs.com/). The CLI tool can be installed using the
following command:

```
npm install -g cloudron
```

Depending on your setup, you may need to run this as root.

You should now be able to run the `cloudron help` command in a shell.


## Subcommands
```
completion                            Shows completion for you shell
backup [options]                      Create backup
build [options]                       Build an app
clone [options]                       Clone an existing app to a new location
createOAuthAppCredentials [options]   Create oauth app credentials for local development
download-backup <id> [outdir]         Download backup
exec [options] [cmd...]               Exec a command in application
inspect [options]                     Inspect a Cloudron returning raw JSON
init                                  Creates a new CloudronManifest.json and Dockerfile
install [options]                     Install or update app into cloudron
list                                  List installed applications
list-backups [options]                List app backups
login [options] [cloudron]            Login to cloudron
logout                                Logout off cloudron
logs [options]                        Application logs
machine                               Cloudron instance tooling
open                                  Open the app in the Browser
published [options]                   List published apps
pull [options] <remote> <local>       pull remote file/dir. Use trailing slash to indicate remote directory.
push [options] <local> <remote>       push local file
restore [options]                     Restore app from last known backup
restart [options]                     Restart the installed application
status [options]                      Application info
submit                                Submit app to the store for review
upload [options]                      Upload app to the store for testing
versions [options]                    List published versions
uninstall [options]                   Uninstall app from cloudron
unpublish [options]                   Unpublish app or app version from the store
```


## Tab completion

To add tab completion to your shell, the cloudron tool can generate it on the fly for the shell you are using. Currently tested on `bash` and `zsh`.

Just run the following in your shell
```
. <(cloudron completion)
```
This command loads the completions into your current shell. Adding it to your ~/.bashrc or ~/.zshrc will make the completions available everywhere.


## Tests

The tests can run against a Cloudron as follows:
```
CLOUDRON=<domain> USERNAME=<username> PASSWORD=<password> mocha tests/
```

