// process.on('unhandledRejection', function (err) {
//     console.trace();
//     console.error(chalk`{red Something went wrong}`);
//     process.exit();
// });
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
import chalk from 'chalk';


// const sanitize = require("sanitize-filename");

const snakeCase = string => {
    return string.replace(/\W+/g, " ")
        .split(/ |\B(?=[A-Z])/)
        .map(word => word.toLowerCase())
        .join('_');
};

const getArgs = () => {
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
        editor: args['--editor'],
        skipPrompt: args['--yes'],
        help: args['--help']
    }
}

const promptConnectionDetails = async (skipList) => {
    console.log(chalk`{bold Please provide the following information:}`);
    let unskippedList = [];

    const promptList = [
        {
            type: 'input',
            name: 'host',
            message: '\tServer Host:',
            initial: 'http://localhost',
        },
        {
            type: 'numeral',
            name: 'port',
            message: '\tPort:',
            initial: function (options) {
                const host = options.enquirer.answers.host;
                const urlObj = new URL(host);

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
            initial: 'odoo',
        },
        {
            type: 'input',
            name: 'username',
            message: '\tUsername:',
            initial: 'admin',
        },
        {
            type: 'input',
            name: 'password',
            message: '\tPassword:',
            initial: 'admin',
        },
    ];

    for (let promptItem of promptList) {
        if (!skipList.includes(promptItem.name)) {
            unskippedList.push(promptItem);
        }
    }

    // console.log(skipList);
    // process.exit();

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

const promptRecordUrl = async () => {
    let url;
    let fieldName;
    let options;
    try {
        url = await prompt({
            type: 'input',
            name: 'url',
            message: 'Record url:',
            initial: 'http://localhost:8069/web#id=288&action=28&model=ir.ui.view&view_type=form&cids=&menu_id=4', // FIXME:: remove. this is only for testing
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
        folderPath = path.join(process.cwd(), 'edit_files');
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
    
    return { watcher, filePath }; 
}

async function watchFile(odoo) {
    const { url, fieldName, options } = await promptRecordUrl();
    const record = await odoo.read(options.model, Number.parseInt(options.id)).then(records => records[0]);
    const field = record[fieldName];

    if (field === undefined) {
        console.error(chalk`{red There is no "${fieldName}" on the record} \n{red Please check the provided information}`);
        process.exit(1);
    }
    console.log(chalk`{green Connected to the record}\n`);

    let { watcher, filePath } = await createWatcher(record, fieldName, odoo, options);
    return { fieldName, filePath, options, record, watcher };
}

function printHelpMessage() {
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
}

const openInEditor = (editorPath, filePath) => {
    const editorExec = child_process.exec(`"${editorPath}" "${filePath}"`);
    // editorExec.stdout.on('data', (data) => console.log(`stdout: ${data}`));
    // editorExec.stderr.on('data', (data) => console.log(`stderr: ${data}`));
    // editorExec.on('close', (code) => console.log(`child process exited with code ${code}`));
}

export async function cli() {
    try {
        const args = getArgs();

        if (args.help) {
            printHelpMessage();
            process.exit(0);
        }

        // defaults
        let { host, port, db, username, password } = {
            host: 'http://localhost',
            port: 8069,
            db: 'odoo',
            username: 'admin',
            password: 'admin',
        };
        const editorPath = args.editor;

        if (!args.skipPrompt) {
            let connectionDetails = await promptConnectionDetails(Object.keys(args).filter(argName => args[argName] !== undefined));
            // merge the connections details provided through the CLI arguments and the prompts
            connectionDetails = { ...args, ...connectionDetails };
            host = connectionDetails.host;
            port = connectionDetails.port;
            db = connectionDetails.db;
            username = connectionDetails.username;
            password = connectionDetails.password;
        }

        if ((new URL(host)).protocol === 'https:' && port === 80) {
            console.log(chalk`{yellow You are using port 80 for https, this is probably a mistake. It should be {blue 443}.}`);
            process.exit();
        }

        // Connect to Odoo
        const odoo = await odooConnect(host, port, db, username, password);

        let { fieldName, filePath, options, record, watcher } = await watchFile(odoo);

        // open the file in editor
        if (editorPath) {
            console.log('Editor path: ', editorPath);
            openInEditor(editorPath, filePath);
        }

        process.stdin.setEncoding('utf8');
        process.stdin.resume();
        process.stdin.on("data", async (data) => {
            const str = data.toString().trim().toLowerCase();
            if (str === 'ch') {
                await watcher.close();
                watcher = await watchFile(odoo);

                // open the file in editor
                if (editorPath) {
                    console.log('Editor path: ', editorPath);
                    openInEditor(editorPath, filePath);
                }
            }
        });
    } catch (error) {
        console.error(error);
        console.error(chalk`{red Something went wrong!}`);
    }
}

// cli();

// const partnerId = await odoo.create('res.partner', {name: 'Kool Keith', email: 'lostinspace@example.com'});
// console.log(`Partner created with ID ${partnerId}`);

