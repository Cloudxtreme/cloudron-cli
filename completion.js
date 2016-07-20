/* jshint node:true */

'use strict';

var helper = require('./helper.js'),
    util = require('util');

require('colors');

exports = module.exports = function (options) {
    var completion = '';

    var commands = [];
    for (var command in options.parent.commands) {
        if (options.parent.commands[command]._name === '*' || options.parent.commands[command]._name === 'completion') continue;
        if (options.parent.commands[command]._name) commands.push(options.parent.commands[command]._name);
        if (options.parent.commands[command]._alias) commands.push(options.parent.commands[command]._alias);
    }
    commands.sort();

    if (!process.env.SHELL) helper.exit('Unable to detect shell');
    if (process.env.SHELL.indexOf('zsh') !== -1) {
        completion += '\n';
        completion += 'function $$cloudron_completion() {\n';
        completion += '  compls="' + commands.join(' ') + '"\n';
        completion += '  completions=(${=compls})\n';
        completion += '  compadd -- $completions\n';
        completion += '}\n';
        completion += '\n';
        completion += 'compdef $$cloudron_completion cloudron\n';
    } else if (process.env.SHELL.indexOf('bash') !== -1) {
        completion += '\n';
        completion += '_cloudron()\n';
        completion += '{\n';
        completion += '  COMPREPLY=( $( compgen -W "' + commands.join(' ') + '" -- ${COMP_WORDS[COMP_CWORD]} ) )\n';
        completion += '}\n';
        completion += 'complete -o default -o nospace -F _cloudron  cloudron\n';

    } else {
        helper.exit(util.format('Unsupported shell %s', process.env.SHELL));
    }

    console.log(completion);
};
