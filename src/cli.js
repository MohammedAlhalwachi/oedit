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
        '--help': Boolean,
        '--yes': Boolean,
        // Aliases
        '-y': '--yes',
    });

    return {
        skipPrompt: args['--yes'],
    }
}

const promptConnectionDetails = async () => {
    console.log(chalk`{bold Please provide the following information:}`);
    return prompt([
        {
            type: 'input',
            name: 'baseUrl',
            message: '\tServer Base URL:',
            initial: 'http://localhost',
        },
        {
            type: 'numeral',
            name: 'port',
            message: '\tPort:',
            initial: '8069',
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
        }
    ]);
}

const odooConnect = async (baseUrl, port, db, username, password) => {
    try {
        const odoo = new Odoo({
            baseUrl: baseUrl,
            port: port,
            db: db,
            username: username,
            password: password
        });

        await odoo.connect();
        console.log(chalk`{green Connected to Odoo:} \n \turl = {blue ${baseUrl}}, port = {blue ${port}} \n \tdb = {blue ${db}}, username = {blue ${username}}, password = {blue ${password}}`);
        console.log(); // prints new line

        return odoo;
    } catch (error) {
        console.error(error);
        console.error(chalk`{red Failed to connect to Odoo with:} \n \turl = {blue ${baseUrl}}, port = {blue ${port}} \n \tdb = {blue ${db}}, username = {blue ${username}}, password = {blue ${password}} \n{red Please check the entered information}`);
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

    return chokidar.watch(filePath).on('change', async (event, path) => {
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

    let watcher = await createWatcher(record, fieldName, odoo, options);
    return { fieldName, options, record, watcher };
}

export async function cli() {
    try {
        const args = getArgs();

        // console.log(args);
        // process.exit();

        let { baseUrl, port, db, username, password } = {
            baseUrl: 'http://localhost',
            port: 8069,
            db: 'odoo',
            username: 'admin',
            password: 'admin',
        };

        if (!args.skipPrompt) {
            const connectionDetails = await promptConnectionDetails();
            baseUrl = connectionDetails.baseUrl;
            port = connectionDetails.port;
            db = connectionDetails.db;
            username = connectionDetails.username;
            password = connectionDetails.password;
        }

        // Connect to Odoo
        const odoo = await odooConnect(baseUrl, port, db, username, password);

        let { fieldName, options, record, watcher } = await watchFile(odoo);

        process.stdin.setEncoding('utf8');
        process.stdin.resume();
        process.stdin.on("data", async (data) => {
            const str = data.toString().trim().toLowerCase();
            if (str === 'ch') {
                await watcher.close();
                watcher = await watchFile(odoo);
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

