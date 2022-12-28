#!/usr/bin/env node
import * as t from "io-ts";
import * as fs from 'fs/promises';
import arg from "arg";
import * as path from "path";
import { simpleGit } from "simple-git";
import copy from "recursive-copy";
import prompt from "prompt";

const DOTGIT = '.git';

const DEFAULTS = {
    contracts: 'contracts',
    package: 'fpm-package.json',
    modules: 'func_modules',
    workdir: '.workdir',
    exports: 'exports',
    lock: 'fpm-lock.json',
};

const argSpec = {
    '-C': String,
};

type Args = arg.Result<typeof argSpec>;

type Handler = (relevantArgs: string[], otherArgs: Args) => Promise<void>;

type PackageDeps = { [name: string]: string };

type Package = {
    name: string
    contracts: string
    dependencies: PackageDeps
};

const packageFile = t.intersection([
    t.type({
        name: t.string,
    }),
    t.partial({
        contracts: t.string,
        dependencies: t.record(t.string, t.string),
    }),
]);

const lockPackage = t.type({
    url: t.string,
    version: t.string,
    commit: t.string,
});

const lockPackages = t.record(t.string, lockPackage);

const lockFile = t.type({
    version: t.literal(1),
    packages: lockPackages,
});

type Lock = t.TypeOf<typeof lockFile>;

class FPMError extends Error {}

function getPackageFromObject(obj: unknown): Package {
    const pkgResult = packageFile.decode(obj);
    if (pkgResult._tag === 'Left') {
        throw new FPMError('Could not decode package');
    }

    const pkg = pkgResult.right;

    const res: Package = {
        ...pkg,
        contracts: pkg.contracts ?? DEFAULTS.contracts,
        dependencies: pkg.dependencies ?? {},
    };

    return res;
}

function getLockFromObject(obj: unknown): Lock {
    const lockResult = lockFile.decode(obj);
    if (lockResult._tag === 'Left') {
        throw new FPMError('Could not decode package');
    }

    return lockResult.right;
}

async function getPackageFromPath(path: string): Promise<Package> {
    const pkgString = JSON.parse((await fs.readFile(path)).toString('utf-8'));

    return getPackageFromObject(pkgString);
}

async function getLockFromPath(path: string): Promise<Lock> {
    const lockString = JSON.parse((await fs.readFile(path)).toString('utf-8'));

    return getLockFromObject(lockString);
}

type PackageInfo = {
    name: string
    url: string
    version: string
};

function getPackageInfos(names: string[], deps: PackageDeps): PackageInfo[] {
    let infos: PackageInfo[] = [];
    for (const dep of names) {
        const ver = deps[dep];
        let name = dep.slice(dep.lastIndexOf('/') + 1);
        if (name.endsWith(DOTGIT)) name = name.slice(0, name.length - DOTGIT.length);
        if (name.length === 0) throw new FPMError(`Dependency ${dep} has empty resolved name`);
        infos.push({
            name,
            url: dep,
            version: ver,
        });
    }
    return infos;
}

function checkDuplicateNames(infos: PackageInfo[]) {
    let exist: { [name: string]: string } = {};
    for (const pkg of infos) {
        if (pkg.name in exist) throw new FPMError(`Packages ${pkg.url} and ${exist[pkg.name]} have the same resolved name ${pkg.name}`);
        exist[pkg.name] = pkg.url;
    }
}

async function install(args: string[], other: Args) {
    const currentPackage = await getPackageFromPath(DEFAULTS.package);
    await installImpl(currentPackage);
}

async function installImpl(currentPackage: Package) {
    const lockPath = DEFAULTS.lock;

    let lock: Lock;
    try {
        lock = await getLockFromPath(lockPath);
    } catch (err) {
        const e = err as any;
        if (e.code === 'ENOENT') {
            lock = {
                version: 1,
                packages: {},
            };
        } else {
            throw e;
        }
    }

    const depNames = Object.keys(currentPackage.dependencies);
    if (depNames.length === 0) {
        console.log(`There are no dependencies`);
        return;
    }

    const modules = path.join(currentPackage.contracts, DEFAULTS.modules);
    const workdir = path.join(modules, DEFAULTS.workdir);

    await fs.rm(workdir, {
        recursive: true,
        force: true,
    });

    await fs.mkdir(workdir, {
        recursive: true,
    });

    const git = simpleGit();

    try {
        const infos = getPackageInfos(depNames, currentPackage.dependencies);

        checkDuplicateNames(infos);

        const wpInfos = infos.map(i => ({ ...i, workpath: path.join(workdir, i.name) }));

        let newLock: Lock = {
            version: 1,
            packages: {},
        };

        let pkgInfos: (typeof wpInfos[number] & { package: Package })[] = [];
        for (const wpInfo of wpInfos) {
            await git.clone(wpInfo.url, wpInfo.workpath, {
                '--depth': '1',
                '--branch': wpInfo.version,
            });
            const pkg = await getPackageFromPath(path.join(wpInfo.workpath, DEFAULTS.package));
            if (pkg.name !== wpInfo.name) throw new FPMError(`Dependency ${wpInfo.url} has resolved name ${wpInfo.name} which does not match package name ${pkg.name}`);
            for (const nestedDep in pkg.dependencies) {
                if (!(nestedDep in currentPackage.dependencies)) console.warn(`Warning: Dependency ${wpInfo.url} has nested dependency ${nestedDep} which is not present in current package`);
            }
            pkgInfos.push({
                ...wpInfo,
                package: pkg,
            });
            const pkgGit = simpleGit(wpInfo.workpath);
            const hash = await pkgGit.revparse(['HEAD']);
            newLock.packages[wpInfo.name] = {
                url: wpInfo.url,
                version: wpInfo.version,
                commit: hash,
            };
            if (wpInfo.name in lock.packages) {
                const locked = lock.packages[wpInfo.name];
                if (locked.url !== wpInfo.url || locked.version !== wpInfo.version) continue;
                if (locked.commit !== hash) throw new FPMError(`Lock file hash mismatch: package ${wpInfo.url} ${wpInfo.version} has stored hash ${locked.commit} but new hash ${hash}`);
            }
        }

        const existingModules = await fs.readdir(modules);
        for (const em of existingModules) {
            if (em === DEFAULTS.workdir) continue;
            await fs.rm(path.join(modules, em), {
                recursive: true,
            });
        }

        for (const pkg of pkgInfos) {
            await copy(path.join(workdir, pkg.name, pkg.package.contracts, DEFAULTS.exports, pkg.name), path.join(modules, pkg.name));
        }

        await fs.writeFile(DEFAULTS.lock, JSON.stringify(newLock, null, '  '));
    } catch (e) {
        throw e;
    } finally {
        await fs.rm(workdir, {
            recursive: true,
        });
    }
}

async function add(args: string[], other: Args) {
    const pkgPath = DEFAULTS.package;

    const currentPackage = await getPackageFromPath(pkgPath);

    const newPackage: Package = {
        ...currentPackage,
        dependencies: {
            ...currentPackage.dependencies,
        },
    };
    const newPkg = args[0];
    const newPkgVer = args[1];

    newPackage.dependencies[newPkg] = newPkgVer;

    try {
        await installImpl(newPackage);
        await fs.writeFile(DEFAULTS.package, JSON.stringify(newPackage, null, '  '));
    } catch (e) {
        throw e;
    }
}

async function init(args: string[], other: Args) {
    prompt.start();

    const p = await prompt.get([
        {
            name: 'name',
            description: 'Project name',
            required: true,
            default: path.basename(process.cwd()),
            pattern: /^[^/]+$/,
        },
        {
            name: 'contracts',
            description: 'Contracts folder',
            required: true,
            default: DEFAULTS.contracts,
            pattern: /^.+$/,
        },
    ]);

    const pkg: t.TypeOf<typeof packageFile> = {
        name: p.name as string,
    };

    if (p.contracts !== DEFAULTS.contracts) pkg.contracts = p.contracts as string;

    await fs.writeFile(DEFAULTS.package, JSON.stringify(pkg, null, '  '));
}

const handlers: { [k: string]: Handler } = {
    install,
    add,
    init,
};

async function main() {
    const args = arg(argSpec);

    if (args['-C'] !== undefined) {
        process.chdir(args['-C']);
    }

    if (args._.length === 0) {
        console.error('Run with -h to see help');
        process.exit(1);
    }

    if (args._[0] in handlers) {
        try {
            await handlers[args._[0]](args._.slice(1), args);
        } catch (err) {
            if (err instanceof FPMError) {
                console.error(err.message);
            } else if (err instanceof Error) {
                console.error(err);
            } else {
                console.error('Unknown error:', err);
            }
            process.exit(1);
        }
        return;
    }

    console.error(`Unknown subcommand ${args._[0]}`);
    process.exit(1);
}

main();