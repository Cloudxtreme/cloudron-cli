# The Cloudron CLI tool

The [Cloudron](https://cloudron.io) CLI tool allows you to install, configure and test apps on your Cloudron.
It is also used to submit your app to the Cloudron Store.


## Installation

Installing the CLI tool requires [node.js](https://nodejs.org/) and
[npm](https://www.npmjs.com/). The CLI tool can be installed using the
following command:

    sudo npm install -g cloudron

Depending on your setup, you may skip the `sudo`.

You should now be able to run the `cloudron help` command in a shell.


## Subcommands
```
completion                            Shows completion for you shell
backup [options]                      Backup app
createOAuthAppCredentials [options]   Create oauth app credentials for local development
build [options]                       Build an app
exec [options] [cmd...]               Exec a command in application
help                                  Show this help
info [options]                        Application info
inspect [options]                     Inspect a Cloudron returning raw JSON
init                                  Creates a new CloudronManifest.json and Dockerfile
install [options]                     Install or update app into cloudron
list                                  List installed applications
login [options] [cloudron]            Login to cloudron
logout                                Logout off cloudron
logs [options]                        Application logs
open                                  Open the app in the Browser
pull [options] <remote> <local>       pull remote file/dir. Use trailing slash to indicate remote directory.
push [options] <local> <remote>       push local file
restore [options]                     Restore app from last known backup
restart [options]                     Restart the installed application
submit                                Submit app to the store (for review)
upload [options]                      Upload app to the store for testing
versions [options]                    List published versions
uninstall [options]                   Uninstall app from cloudron
unpublish [options]                   Unpublish app or app version from the store
published                             List published apps

```


## Tab completion

To add tab completion to your shell, the cloudron tool can generate it on the fly for the shell you are using. Currently tested on `bash` and `zsh`.

Just run the following in your shell
```
. <(cloudron completion)
```
This command loads the completions into your current shell. Adding it to your ~/.bashrc or ~/.zshrc will make the completions available everywhere.
