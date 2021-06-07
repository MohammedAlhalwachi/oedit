require = require('esm')(module, /*, options */);
const querystring = require('querystring');
const Odoo = require('odoo-await');
const fs = require('fs').promises;
const rmdirSync = require('fs').rmdirSync;
const path = require('path');
const mkdirp = require('mkdirp');
const chokidar = require('chokidar');
const { Select, prompt } = require('enquirer');
const arg = require('arg');
const commandLineUsage = require('command-line-usage')
const child_process = require('child_process');
const os = require('os');
import chalk from 'chalk';


const snakeCase = string => {
    return string.replace(/\W+/g, " ")
        .split(/ |\B(?=[A-Z])/)
        .map(word => word.toLowerCase())
        .join('_');
};

const getCliArgs = () => {
    const args = arg({
        '--host': String,
        '--port': Number,
        '--database': String,
        '--username': String,
        '--password': String,
        '--editor': String,
        '--help': Boolean,
        '--yes': Boolean,
        // Aliases
        '-h': '--host',
        '-p': '--port',
        '-d': '--database',
        '-u': '--username',
        '-s': '--password',
        '-e': '--editor',
        '-y': '--yes',
    });

    return {
        host: args['--host'],
        port: args['--port'],
        db: args['--database'],
        username: args['--username'],
        password: args['--password'],
        editorPath: args['--editor'],
        skipPrompt: args['--yes'],
        help: args['--help']
    }
}

const getPreviousArgs = async () => {
    const configPath = path.join(os.tmpdir(), 'oedit_config/previousArgs.json');
    const config = await fs.readFile(configPath).then(file => JSON.parse(file.toString())).catch(e => ({}));

    return config;
};

const updatePreviousArgs = async (newArgs) => {
    const configPath = path.join(os.tmpdir(), 'oedit_config/previousArgs.json');
    const config = getPreviousArgs();

    await mkdirp(path.dirname(configPath));
    await fs.writeFile(configPath, JSON.stringify({ ...config, ...newArgs }));
};

const promptConnectionDetails = async (skipList) => {
    console.log(chalk`{bold Please provide the following information:}`);
    let unskippedList = [];
    const previousArgs = await getPreviousArgs();
    const getPreviousArg = (name) => {
        return previousArgs[name];
    };

    const promptList = [
        {
            type: 'input',
            name: 'host',
            message: '\tServer Host:',
            initial: getPreviousArg('host') || 'http://localhost'
        },
        {
            type: 'input',
            name: 'port',
            message: '\tPort:',
            initial: function (options) {
                const host = options.enquirer.answers.host;
                if (!host) return '8069';

                const urlObj = new URL(host);
                if (urlObj.port)
                    return urlObj.port;

                // if its localhost suggest port 8069
                if (urlObj.host === 'localhost')
                    return '8069';

                // otherwise suggest a port depending on the protocol
                return urlObj.protocol === 'https:' ? '443' : '80';
            },
        },
        {
            type: 'input',
            name: 'db',
            message: '\tDatabase:',
            initial: function (options) {
                const host = options.enquirer.answers.host;
                if (!host) return getPreviousArg('db') || 'odoo';

                const urlObj = new URL(host);
                const urlParts = urlObj.host.split(".");

                // if the url has 3 or more parts, it means a subdomain is present
                if (urlParts.length >= 3) {
                    // return the first part, the subdomain
                    return urlParts[0];
                } else {
                    return getPreviousArg('db') || 'odoo';
                }
            },
        },
        {
            type: 'input',
            name: 'username',
            message: '\tUsername:',
            initial: getPreviousArg('username') || 'admin'
        },
        {
            type: 'input',
            name: 'password',
            message: '\tPassword:',
            initial: getPreviousArg('password') || 'admin'
        },
    ];

    // skip the prompt that are provided int he skip list
    for (let promptItem of promptList) {
        if (!skipList.includes(promptItem.name)) {
            unskippedList.push(promptItem);
        }
    }

    return prompt(unskippedList);
}

const odooConnect = async (host, port, db, username, password) => {
    try {
        const odoo = new Odoo({
            baseUrl: host,
            port: port,
            db: db,
            username: username,
            password: password
        });

        await odoo.connect();
        console.log(chalk`{green Connected to Odoo:} \n \turl = {blue ${host}}, port = {blue ${port}} \n \tdb = {blue ${db}}, username = {blue ${username}}, password = {blue ${password}}`);
        console.log(); // prints new line

        return odoo;
    } catch (error) {
        console.error(error);
        console.error(chalk`{red Failed to connect to Odoo with:} \n \turl = {blue ${host}}, port = {blue ${port}} \n \tdb = {blue ${db}}, username = {blue ${username}}, password = {blue ${password}} \n{red Please check the entered information}`);
        process.exit(1);
    }
}

const promptRecordUrl = async (suggestion) => {
    let url;
    let fieldName;
    let options;
    try {
        url = await prompt({
            type: 'input',
            name: 'url',
            message: 'Record url:',
            initial: suggestion || ''
        }).then(res => res.url);
        // validate and get the options out of the url
        let urlObj = new URL(url); // this also validate the url
        options = querystring.parse(urlObj.hash.slice(1));

        fieldName = await prompt({
            type: 'input',
            name: 'field',
            message: 'Field name:',
            initial: 'arch_base'
        }).then(res => res.field);

    } catch (error) {
        console.error(chalk`{red Failed to read the record:} \n \turl = {blue ${url}} \n{red Please check the provided information}`);
        process.exit(1);
    }

    return {
        url,
        fieldName,
        options
    }
}

async function createWatcher(record, fieldName, odoo, options) {
    let folderPath;
    let fileExt;
    let filePath;
    try {
        folderPath = path.join(os.tmpdir(), 'oedit_edit_files');
        fileExt = path.extname(record.arch_fs || '');
        if (fileExt === '') {
            const extPrompt = new Select({
                name: 'ext',
                message: 'File Extension:',
                choices: ['xml', 'py', 'other']
            });

            let extResponse = await extPrompt.run();
            if (extResponse === 'other') {
                extResponse = await prompt({
                    type: 'input',
                    name: 'ext',
                    message: 'File Extension:',
                }).then(res => res.ext);
            }
            fileExt = '.' + extResponse;
        }
        filePath = path.join(folderPath, snakeCase(record.name + '_' + record.id) + fileExt);
        await mkdirp(folderPath);
        await fs.writeFile(filePath, record[fieldName]);

        process.on('exit', () => {
            // delete edit_files folder and its contents
            rmdirSync(folderPath, { recursive: true });
            process.exit();
        });

        console.log(chalk`{green File created and watched at} {blue ${filePath}}\n`);
        console.log(chalk`{blue To change the watched record press 'ch'}\n`);
    } catch (error) {
        console.error(error);
        console.error(chalk`{red An error happened while creating the file}`);
        process.exit();
    }

    const watcher = chokidar.watch(filePath).on('change', async (event, path) => {
        const file = await fs.readFile(filePath).then(file => file.toString());
        try {
            const isSuccessful = await odoo.update(options.model, Number.parseInt(options.id), {
                [fieldName]: file,
            });
            if (!isSuccessful) throw new Error('Updating the record was not successful');
            console.log(chalk`{blue Record updated}`);
        } catch (error) {
            console.error(error);
            console.error(chalk`{red Failed to update the record. Check the error above.}`);
        }
    });

    return { watcher, folderPath, filePath };
}

async function watchFile(odoo, editorPath, host) {
    const { url, fieldName, options } = await promptRecordUrl(host);
    const record = await odoo.read(options.model, Number.parseInt(options.id)).then(records => records[0]);
    const field = record[fieldName];

    if (field === undefined) {
        console.error(chalk`{red There is no "${fieldName}" on the record} \n{red Please check the provided information}`);
        process.exit(1);
    }
    console.log(chalk`{green Connected to the record}\n`);

    let { watcher, folderPath, filePath } = await createWatcher(record, fieldName, odoo, options);

    // open the file in editor
    if (editorPath) {
        openInEditor(editorPath, filePath);
    } else {
        openInFileExplorer(folderPath);
    }
    return { fieldName, filePath, options, record, watcher };
}

const printHelpMessage = () => {
    const sections = [
        {
            header: 'Oedit',
            content: 'A CLI to allow connecting IDE\'s to lively edit odoo\'s code models.'
        },
        {
            header: 'Options',
            optionList: [
                {
                    name: 'help',
                    type: Boolean,
                    description: 'Print this usage guide.'
                },
                {
                    name: 'yes',
                    alias: 'y',
                    type: Boolean,
                    description: 'Set the connection details to the default values.'
                },
                {
                    name: 'host',
                    alias: 'h',
                    description: 'Set the connection host.'
                },
                {
                    name: 'port',
                    alias: 'p',
                    typeLabel: '{underline number}',
                    description: 'Set the connection port.'
                },
                {
                    name: 'database',
                    alias: 'd',
                    description: 'Set the connection database.'
                },
                {
                    name: 'username',
                    alias: 'u',
                    description: 'Set the connection username.'
                },
                {
                    name: 'password',
                    alias: 's',
                    description: 'Set the connection password.'
                },
                {
                    name: 'editor',
                    alias: 'e',
                    description: 'Set the editor path.'
                },
            ]
        }
    ];

    const usage = commandLineUsage(sections);
    console.log(usage);
};

const openInFileExplorer = (filePath) => {
    const explorerExec = child_process.exec(`start "" "${filePath}"`);
}

const openInEditor = (editorPath, filePath) => {
    const editorExec = child_process.exec(`"${editorPath}" "${filePath}"`);
}

const getArgs = async () => {
    const defaultArgs = {
        host: 'http://localhost',
        port: 8069,
        db: 'odoo',
        username: 'admin',
        password: 'admin',
    };
    const cliArgs = getCliArgs();
    let promptArgs = {};

    if (!cliArgs.skipPrompt) {
        promptArgs = await promptConnectionDetails(Object.keys(cliArgs).filter(argName => cliArgs[argName] !== undefined));
    }

    // merge the connections details provided through the CLI arguments and the prompts
    const args = { ...defaultArgs, ...cliArgs, ...promptArgs };

    // make sure the user doesn't enter invalid port for a specific protocol
    if ((new URL(args.host)).protocol === 'https:' && args.port === 80) {
        console.log(chalk`{yellow You are using port 80 for https, this is probably a mistake. It should be {blue 443}.}`);
        process.exit(0);
    }
    await updatePreviousArgs(args);

    return args;
}

export async function cli() {
    try {
        const args = await getArgs();

        if (args.help) {
            printHelpMessage();
            process.exit(0);
        }

        // Connect to Odoo
        const odoo = await odooConnect(args.host, args.port, args.db, args.username, args.password);
        let { fieldName, filePath, options, record, watcher } = await watchFile(odoo, args.editorPath, args.host);

        process.stdin.setEncoding('utf8');
        process.stdin.resume();
        process.stdin.on("data", async (data) => {
            const str = data.toString().trim().toLowerCase();
            if (str === 'ch') {
                await watcher.close();
                watcher = await watchFile(odoo, args.editorPath, args.host).then(obj => obj.watcher);

                // needed to resume for listening for "ch" on stdin after watchFile()
                process.stdin.resume();
            }
        });
    } catch (error) {
        console.error(error);
        console.error(chalk`{red Something went wrong!}`);
    }
}