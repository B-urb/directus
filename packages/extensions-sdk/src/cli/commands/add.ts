import path from 'path';
import chalk from 'chalk';
import fse from 'fs-extra';
import inquirer from 'inquirer';
import { log } from '../utils/logger';
import {
	ExtensionManifestRaw,
	ExtensionOptions,
	ExtensionOptionsBundleEntry,
	ExtensionType,
} from '@directus/shared/types';
import { isIn, isTypeIn, validateExtensionManifest } from '@directus/shared/utils';
import {
	EXTENSION_LANGUAGES,
	EXTENSION_NAME_REGEX,
	EXTENSION_PKG_KEY,
	EXTENSION_TYPES,
	HYBRID_EXTENSION_TYPES,
} from '@directus/shared/constants';
import { getLanguageFromPath, isLanguage, languageToShort } from '../utils/languages';
import { Language } from '../types';
import getExtensionDevDeps from './helpers/get-extension-dev-deps';
import execa from 'execa';
import ora from 'ora';
import copyTemplate from './helpers/copy-template';
import detectJsonIndent from '../utils/detect-json-indent';
import getPackageManager from '../utils/get-package-manager';

export default async function add(): Promise<void> {
	const extensionPath = process.cwd();
	const packagePath = path.resolve('package.json');

	if (!(await fse.pathExists(packagePath))) {
		log(`Current directory is not a valid package.`, 'error');
		process.exit(1);
	}

	const extensionManifestFile = await fse.readFile(packagePath, 'utf8');
	const extensionManifest: ExtensionManifestRaw = JSON.parse(extensionManifestFile);

	const indent = detectJsonIndent(extensionManifestFile);

	if (!validateExtensionManifest(extensionManifest)) {
		log(`Current directory is not a valid Directus extension.`, 'error');
		process.exit(1);
	}

	const extensionOptions = extensionManifest[EXTENSION_PKG_KEY];

	if (extensionOptions.type === 'pack') {
		log(`Adding entries to extensions with type ${chalk.bold('pack')} is not currently supported.`, 'error');
		process.exit(1);
	}

	const sourceExists = await fse.pathExists(path.resolve('src'));

	if (extensionOptions.type === 'bundle') {
		const { type, name, language, alternativeSource } = await inquirer.prompt<{
			type: ExtensionType;
			name: string;
			language: Language;
			alternativeSource?: string;
		}>([
			{
				type: 'list',
				name: 'type',
				message: 'Choose the extension type',
				choices: EXTENSION_TYPES,
			},
			{
				type: 'input',
				name: 'name',
				message: 'Choose a name for the entry',
				validate: (name: string) => (name.length === 0 ? 'Entry name can not be empty.' : true),
			},
			{
				type: 'list',
				name: 'language',
				message: 'Choose the language to use',
				choices: EXTENSION_LANGUAGES,
			},
			{
				type: 'input',
				name: 'alternativeSource',
				message: 'Specify the path to the extension source',
				when: !sourceExists && extensionOptions.entries.length > 0,
			},
		]);

		const spinner = ora(chalk.bold('Modifying Directus extension...')).start();

		const source = alternativeSource ?? 'src';

		const sourcePath = path.resolve(source, name);

		await fse.ensureDir(sourcePath);
		await copyTemplate(type, extensionPath, sourcePath, language);

		const newEntries: ExtensionOptionsBundleEntry[] = [
			...extensionOptions.entries,
			isIn(type, HYBRID_EXTENSION_TYPES)
				? {
						type,
						name,
						source: {
							app: `${source}/${name}/app.${languageToShort(language)}`,
							api: `${source}/${name}/api.${languageToShort(language)}`,
						},
				  }
				: {
						type,
						name,
						source: `${source}/${name}/index.${languageToShort(language)}`,
				  },
		];

		const newExtensionOptions: ExtensionOptions = { ...extensionOptions, entries: newEntries };
		const newExtensionManifest = {
			...extensionManifest,
			[EXTENSION_PKG_KEY]: newExtensionOptions,
			devDependencies: await getExtensionDevDeps(
				newEntries.map((entry) => entry.type),
				getLanguageFromEntries(newEntries)
			),
		};

		await fse.writeJSON(packagePath, newExtensionManifest, { spaces: indent ?? '\t' });

		const packageManager = getPackageManager();

		await execa(packageManager, ['install'], { cwd: extensionPath });

		spinner.succeed(chalk.bold('Done'));
	} else {
		const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
			{
				type: 'confirm',
				name: 'proceed',
				message: 'This will convert your extension to a bundle. Do you want to proceed?',
			},
		]);

		if (!proceed) {
			log(`Extension has not been modified.`, 'info');
			process.exit(1);
		}

		const oldName = extensionManifest.name.match(EXTENSION_NAME_REGEX)?.[1] ?? extensionManifest.name;

		const { type, name, language, convertName, extensionName, alternativeSource } = await inquirer.prompt<{
			type: ExtensionType;
			name: string;
			language: Language;
			convertName: string;
			extensionName: string;
			alternativeSource?: string;
		}>([
			{
				type: 'list',
				name: 'type',
				message: 'Choose the extension type',
				choices: EXTENSION_TYPES,
			},
			{
				type: 'input',
				name: 'name',
				message: 'Choose a name for the entry',
				validate: (name: string) => (name.length === 0 ? 'Entry name can not be empty.' : true),
			},
			{
				type: 'list',
				name: 'language',
				message: 'Choose the language to use',
				choices: EXTENSION_LANGUAGES,
			},
			{
				type: 'input',
				name: 'convertName',
				message: 'Choose a name for the extension that is converted to an entry',
				default: oldName,
				validate: (name: string) => (name.length === 0 ? 'Entry name can not be empty.' : true),
			},
			{
				type: 'input',
				name: 'extensionName',
				message: 'Choose a name for the extension',
				default: ({ convertName }: { convertName: string }) => (convertName !== oldName ? oldName : null),
				validate: (name: string) => (name.length === 0 ? 'Extension name can not be empty.' : true),
			},
			{
				type: 'input',
				name: 'alternativeSource',
				message: 'Specify the path to the extension source',
				when: !sourceExists,
			},
		]);

		const spinner = ora(chalk.bold('Modifying Directus extension...')).start();

		const source = alternativeSource ?? 'src';

		const convertSourcePath = path.resolve(source, convertName);
		const entrySourcePath = path.resolve(source, name);

		const convertFiles = await fse.readdir(source);

		await Promise.all(
			convertFiles.map((file) => fse.move(path.resolve(source, file), path.join(convertSourcePath, file)))
		);

		await fse.ensureDir(entrySourcePath);
		await copyTemplate(type, extensionPath, entrySourcePath, language);

		const entries: ExtensionOptionsBundleEntry[] = [
			isTypeIn(extensionOptions, HYBRID_EXTENSION_TYPES)
				? {
						type: extensionOptions.type,
						name: convertName,
						source: {
							app: path.posix.join(source, convertName, path.posix.relative(source, extensionOptions.source.app)),
							api: path.posix.join(source, convertName, path.posix.relative(source, extensionOptions.source.api)),
						},
				  }
				: {
						type: extensionOptions.type,
						name: convertName,
						source: path.posix.join(source, convertName, path.posix.relative(source, extensionOptions.source)),
				  },
			isIn(type, HYBRID_EXTENSION_TYPES)
				? {
						type,
						name,
						source: {
							app: `${source}/${name}/app.${languageToShort(language)}`,
							api: `${source}/${name}/api.${languageToShort(language)}`,
						},
				  }
				: {
						type,
						name,
						source: `${source}/${name}/index.${languageToShort(language)}`,
				  },
		];

		const newExtensionOptions: ExtensionOptions = {
			type: 'bundle',
			path: { app: 'dist/app.js', api: 'dist/api.js' },
			entries,
			host: extensionOptions.host,
			hidden: extensionOptions.hidden,
		};
		const newExtensionManifest = {
			...extensionManifest,
			name: EXTENSION_NAME_REGEX.test(extensionName) ? extensionName : `directus-extension-${extensionName}`,
			keywords: ['directus', 'directus-extension', `directus-custom-bundle`],
			[EXTENSION_PKG_KEY]: newExtensionOptions,
			devDependencies: await getExtensionDevDeps(
				entries.map((entry) => entry.type),
				getLanguageFromEntries(entries)
			),
		};

		await fse.writeJSON(packagePath, newExtensionManifest, { spaces: indent ?? '\t' });

		const packageManager = getPackageManager();

		await execa(packageManager, ['install'], { cwd: extensionPath });

		spinner.succeed(chalk.bold('Done'));
	}
}

function getLanguageFromEntries(entries: ExtensionOptionsBundleEntry[]): Language[] {
	const languages = new Set<Language>();

	for (const entry of entries) {
		if (isTypeIn(entry, HYBRID_EXTENSION_TYPES)) {
			const languageApp = getLanguageFromPath(entry.source.app);
			const languageApi = getLanguageFromPath(entry.source.api);

			if (!isLanguage(languageApp)) {
				log(`App language ${chalk.bold(languageApp)} is not supported.`, 'error');
				process.exit(1);
			}
			if (!isLanguage(languageApi)) {
				log(`API language ${chalk.bold(languageApi)} is not supported.`, 'error');
				process.exit(1);
			}

			languages.add(languageApp);
			languages.add(languageApi);
		} else {
			const language = getLanguageFromPath(entry.source);

			if (!isLanguage(language)) {
				log(`Language ${chalk.bold(language)} is not supported.`, 'error');
				process.exit(1);
			}

			languages.add(language);
		}
	}

	return Array.from(languages);
}
