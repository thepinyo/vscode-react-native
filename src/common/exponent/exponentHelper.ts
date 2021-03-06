// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as path from "path";
import * as Q from "q";
import * as XDL from "./xdlInterface";
import stripJsonComments = require("strip-json-comments");

import {FileSystem} from "../node/fileSystem";
import {Package} from "../node/package";
import {ReactNativeProjectHelper} from "../reactNativeProjectHelper";
import {CommandVerbosity, CommandExecutor} from "../commandExecutor";
import {HostPlatform} from "../hostPlatform";
import {Log} from "../log/log";

const VSCODE_EXPONENT_JSON = "vscodeExponent.json";
const EXPONENT_INDEX = "exponentIndex.js";
const DEFAULT_EXPONENT_INDEX = "main.js";
const DEFAULT_IOS_INDEX = "index.ios.js";
const DEFAULT_ANDROID_INDEX = "index.android.js";
const EXP_JSON = "exp.json";
const SECONDS_IN_DAY = 86400;

enum ReactNativePackageStatus {
    FACEBOOK_PACKAGE,
    EXPONENT_PACKAGE,
    UNKNOWN
}

export class ExponentHelper {
    private rootPath: string;
    private fileSystem: FileSystem;
    private commandExecutor: CommandExecutor;

    private expSdkVersion: string;
    private entrypointFilename: string;
    private entrypointComponentName: string;

    private dependencyPackage: ReactNativePackageStatus;
    private hasInitialized: boolean;

    public constructor(projectRootPath: string) {
        this.rootPath = projectRootPath;
        this.hasInitialized = false;
        // Constructor is slim by design. This is to add as less computation as possible
        // to the initialization of the extension. If a public method is added, make sure
        // to call this.lazilyInitialize() at the begining of the code to be sure all variables
        // are correctly initialized.
    }

    /**
     * Convert react native project to exponent.
     * This consists on three steps:
     * 1. Change the dependency from facebook's react-native to exponent's fork
     * 2. Create exp.json
     * 3. Create index and entrypoint for exponent
     */
    public configureExponentEnvironment(): Q.Promise<void> {
        this.lazilyInitialize();
        Log.logMessage("Making sure your project uses the correct dependencies for exponent. This may take a while...");
        return this.changeReactNativeToExponent()
            .then(() => {
                Log.logMessage("Dependencies are correct. Making sure you have any necessary configuration file.");
                return this.ensureExpJson();
            }).then(() => {
                Log.logMessage("Project setup is correct. Generating entrypoint code.");
                this.createIndex();
            });
    }

    /**
     * Change dependencies to point to original react-native repo
     */
    public configureReactNativeEnvironment(): Q.Promise<void> {
        this.lazilyInitialize();
        Log.logMessage("Checking react native is correctly setup. This may take a while...");
        return this.changeExponentToReactNative();
    }

    /**
     * Returns the current user. If there is none, asks user for username and password and logins to exponent servers.
     */
    public loginToExponent(promptForInformation: (message: string, password: boolean) => Q.Promise<string>, showMessage: (message: string) => Q.Promise<string>): Q.Promise<XDL.IUser> {
        this.lazilyInitialize();
        return XDL.currentUser()
            .then((user) => {
                if (!user) {
                    let username = "";
                    return showMessage("You need to login to exponent. Please provide username and password to login. If you don't have an account we will create one for you.")
                        .then(() =>
                            promptForInformation("Exponent username", false)
                        ).then((name) => {
                            username = name;
                            return promptForInformation("Exponent password", true);
                        })
                        .then((password) =>
                            XDL.login(username, password));
                }
                return user;
            })
            .catch(error => {
                return Q.reject<XDL.IUser>(error);
            });
    }

    /**
     * File used as an entrypoint for exponent. This file's component should be registered as "main"
     * in the AppRegistry and should only render a entrypoint component.
     */
    private createIndex(): Q.Promise<void> {
        this.lazilyInitialize();
        const pkg = require("../../../package.json");
        const extensionVersionNumber = pkg.version;
        const extensionName = pkg.name;

        return Q.all<string>([this.entrypointComponent(), this.entrypoint()])
            .spread((componentName: string, entryPointFile: string) => {
                const fileContents =
                    `// This file is automatically generated by ${extensionName}@${extensionVersionNumber}
// Please do not modify it manually. All changes will be lost.
var React = require('react');
var {Component} = React;

var ReactNative = require('react-native');
var {AppRegistry} = ReactNative;

var entryPoint = require("../${entryPointFile}");

AppRegistry.registerRunnable('main', (appParameters) => {
    AppRegistry.runApplication('${componentName}', appParameters);
});`;
                return this.fileSystem.writeFile(this.dotvscodePath(EXPONENT_INDEX), fileContents);
            });
    }

    /**
     * Create exp.json file in the workspace root if not present
     */
    private ensureExpJson(): Q.Promise<void> {
        this.lazilyInitialize();
        let defaultSettings = {
            "sdkVersion": "",
            "entryPoint": EXPONENT_INDEX,
            "slug": "",
            "name": "",
        };
        return this.readVscodeExponentSettingFile()
            .then(exponentJson => {
                const expJsonPath = this.pathToFileInWorkspace(EXP_JSON);
                if (!this.fileSystem.existsSync(expJsonPath) || exponentJson.overwriteExpJson) {
                    return this.getPackageName()
                        .then(name => {
                            // Name and slug are supposed to be the same,
                            // but slug only supports alpha numeric and -,
                            // while name should be human readable
                            defaultSettings.slug = name.replace(" ", "-");
                            defaultSettings.name = name;
                            return this.exponentSdk();
                        })
                        .then(exponentVersion => {
                            if (!exponentVersion) {
                                return XDL.supportedVersions()
                                    .then((versions) => {
                                        return Q.reject<void>(new Error(`React Native version not supported by exponent. Major versions supported: ${versions.join(", ")}`));
                                    });
                            }
                            defaultSettings.sdkVersion = exponentVersion;
                            return this.fileSystem.writeFile(expJsonPath, JSON.stringify(defaultSettings, null, 4));
                        });
                }
            });
    }

    /**
     * Changes npm dependency from react native to exponent's fork
     */
    private changeReactNativeToExponent(): Q.Promise<void> {
        Log.logString("Checking if react native is from exponent.");
        return this.usingReactNativeExponent(true)
            .then(usingExponent => {
                Log.logString(".\n");
                if (usingExponent) {
                    return Q.resolve<void>(void 0);
                }
                Log.logString("Getting appropriate Exponent SDK Version to install.");
                return this.exponentSdk(true)
                    .then(sdkVersion => {
                        Log.logString(".\n");
                        if (!sdkVersion) {
                            return XDL.supportedVersions()
                                .then((versions) => {
                                    return Q.reject<void>(new Error(`React Native version not supported by exponent. Major versions supported: ${versions.join(", ")}`));
                                });
                        }
                        const exponentFork = `github:exponentjs/react-native#sdk-${sdkVersion}`;
                        Log.logString("Uninstalling current react native package.");
                        return Q(this.commandExecutor.spawnWithProgress(HostPlatform.getNpmCliCommand("npm"), ["uninstall", "react-native", "--verbose"], { verbosity: CommandVerbosity.PROGRESS }))
                            .then(() => {
                                Log.logString("Installing exponent react native package.");
                                return this.commandExecutor.spawnWithProgress(HostPlatform.getNpmCliCommand("npm"), ["install", exponentFork, "--cache-min", SECONDS_IN_DAY.toString(10), "--verbose"], { verbosity: CommandVerbosity.PROGRESS });
                            });
                    });
            })
            .then(() => {
                this.dependencyPackage = ReactNativePackageStatus.EXPONENT_PACKAGE;
            });
    }

    /**
     * Changes npm dependency from exponent's fork to react native
     */
    private changeExponentToReactNative(): Q.Promise<void> {
        Log.logString("Checking if the correct react native is installed.");
        return this.usingReactNativeExponent()
            .then(usingExponent => {
                Log.logString(".\n");
                if (!usingExponent) {
                    return Q.resolve<void>(void 0);
                }
                Log.logString("Uninstalling current react native package.");
                return Q(this.commandExecutor.spawnWithProgress(HostPlatform.getNpmCliCommand("npm"), ["uninstall", "react-native", "--verbose"], { verbosity: CommandVerbosity.PROGRESS }))
                    .then(() => {
                        Log.logString("Installing correct react native package.");
                        return this.commandExecutor.spawnWithProgress(HostPlatform.getNpmCliCommand("npm"), ["install", "react-native", "--cache-min", SECONDS_IN_DAY.toString(10), "--verbose"], { verbosity: CommandVerbosity.PROGRESS });
                    });
            })
            .then(() => {
                this.dependencyPackage = ReactNativePackageStatus.FACEBOOK_PACKAGE;
            });
    }

    /**
     * Reads VSCODE_EXPONENT Settings file. If it doesn't exists it creates one by
     * guessing which entrypoint and filename to use.
     */
    private readVscodeExponentSettingFile(): Q.Promise<any> {
        // Only create a new one if there is not one already
        return this.fileSystem.exists(this.dotvscodePath(VSCODE_EXPONENT_JSON))
            .then((vscodeExponentExists: boolean) => {
                if (vscodeExponentExists) {
                    return this.fileSystem.readFile(this.dotvscodePath(VSCODE_EXPONENT_JSON), "utf-8")
                        .then(function (jsonContents: string): Q.Promise<any> {
                            return JSON.parse(stripJsonComments(jsonContents));
                        });
                } else {
                    let defaultSettings = {
                        "entryPointFilename": "",
                        "entryPointComponent": "",
                        "overwriteExpJson": false,
                    };
                    return this.getPackageName()
                        .then(packageName => {
                            // By default react-native uses the package name for the entry component. This is our safest guess.
                            defaultSettings.entryPointComponent = packageName;
                            this.entrypointComponentName = defaultSettings.entryPointComponent;
                            return Q.all([
                                this.fileSystem.exists(this.pathToFileInWorkspace(DEFAULT_IOS_INDEX)),
                                this.fileSystem.exists(this.pathToFileInWorkspace(DEFAULT_EXPONENT_INDEX)),
                            ]);
                        })
                        .spread((indexIosExists: boolean, mainExists: boolean) => {
                            // If there is an ios entrypoint we want to use that, if not let's go with android
                            defaultSettings.entryPointFilename =
                                  mainExists ? DEFAULT_EXPONENT_INDEX
                                : indexIosExists ? DEFAULT_IOS_INDEX
                                : DEFAULT_ANDROID_INDEX;
                            this.entrypointFilename = defaultSettings.entryPointFilename;
                            return this.fileSystem.writeFile(this.dotvscodePath(VSCODE_EXPONENT_JSON), JSON.stringify(defaultSettings, null, 4));
                        })
                        .then(() => {
                            return defaultSettings;
                        });
                }
            });
    }

    /**
     * Exponent sdk version that maps to the current react-native version
     * If react native version is not supported it returns null.
     */
    private exponentSdk(showProgress: boolean = false): Q.Promise<string> {
        if (showProgress) Log.logString("...");
        if (this.expSdkVersion) {
            return Q(this.expSdkVersion);
        }
        return this.readFromExpJson<string>("sdkVersion")
            .then((sdkVersion) => {
                if (showProgress) Log.logString(".");
                if (sdkVersion) {
                    this.expSdkVersion = sdkVersion;
                    return this.expSdkVersion;
                }
                let reactNativeProjectHelper = new ReactNativeProjectHelper(this.rootPath);
                return reactNativeProjectHelper.getReactNativeVersion()
                    .then(version => {
                        if (showProgress) Log.logString(".");
                        return XDL.mapVersion(version)
                            .then(exponentVersion => {
                                this.expSdkVersion = exponentVersion;
                                return this.expSdkVersion;
                            });
                    });
            });
    }

    /**
     * Returns the specified setting from exp.json if it exists
     */
    private readFromExpJson<T>(setting: string): Q.Promise<T> {
        const expJsonPath = this.pathToFileInWorkspace(EXP_JSON);
        return this.fileSystem.exists(expJsonPath)
            .then((exists: boolean) => {
                if (!exists) {
                    return null;
                }
                return this.fileSystem.readFile(expJsonPath, "utf-8")
                    .then(function (jsonContents: string): Q.Promise<T> {
                        return JSON.parse(stripJsonComments(jsonContents))[setting];
                    });
            });
    }

    /**
     * Looks at the _from attribute in the package json of the react-native dependency
     * to figure out if it's using exponent.
     */
    private usingReactNativeExponent(showProgress: boolean = false): Q.Promise<boolean> {
        if (showProgress) Log.logString("...");
        if (this.dependencyPackage !== ReactNativePackageStatus.UNKNOWN) {
            return Q(this.dependencyPackage === ReactNativePackageStatus.EXPONENT_PACKAGE);
        }
        // Look for the package.json of the dependecy
        const pathToReactNativePackageJson = path.resolve(this.rootPath, "node_modules", "react-native", "package.json");
        return this.fileSystem.readFile(pathToReactNativePackageJson, "utf-8")
            .then(jsonContents => {
                const packageJson = JSON.parse(jsonContents);
                const isExp = /\bexponentjs\/react-native\b/.test(packageJson._from);
                this.dependencyPackage = isExp ? ReactNativePackageStatus.EXPONENT_PACKAGE : ReactNativePackageStatus.FACEBOOK_PACKAGE;
                if (showProgress) Log.logString(".");
                return isExp;
            }).catch(() => {
                if (showProgress) Log.logString(".");
                // Not in a react-native project
                return false;
            });
    }

    /**
     * Name of the file (we assume it lives in the workspace root) that should be used as entrypoint.
     * e.g. index.ios.js
     */
    private entrypoint(): Q.Promise<string> {
        if (this.entrypointFilename) {
            return Q(this.entrypointFilename);
        }
        return this.readVscodeExponentSettingFile()
            .then((settingsJson) => {
                // Let's load both to memory to make sure we are not reading from memory next time we query for this.
                this.entrypointFilename = settingsJson.entryPointFilename;
                this.entrypointComponentName = settingsJson.entryPointComponent;
                return this.entrypointFilename;
            });
    }

    /**
     * Name of the component used as an entrypoint for the app.
     */
    private entrypointComponent(): Q.Promise<string> {
        if (this.entrypointComponentName) {
            return Q(this.entrypointComponentName);
        }
        return this.readVscodeExponentSettingFile()
            .then((settingsJson) => {
                // Let's load both to memory to make sure we are not reading from memory next time we query for this.
                this.entrypointComponentName = settingsJson.entryPointComponent;
                this.entrypointFilename = settingsJson.entrypointFilename;
                return this.entrypointComponentName;
            });
    }

    /**
     * Path to the a given file inside the .vscode directory
     */
    private dotvscodePath(filename: string): string {
        return path.join(this.rootPath, ".vscode", filename);
    }

    /**
     * Path to the a given file from the workspace root
     */
    private pathToFileInWorkspace(filename: string): string {
        return path.join(this.rootPath, filename);
    }

    /**
     * Name specified on user's package.json
     */
    private getPackageName(): Q.Promise<string> {
        return new Package(this.rootPath, { fileSystem: this.fileSystem }).name();
    }

    /**
     * Works as a constructor but only initiliazes when it's actually needed.
     */
    private lazilyInitialize(): void {
        if (!this.hasInitialized) {
            this.hasInitialized = true;
            this.fileSystem = new FileSystem();
            this.commandExecutor = new CommandExecutor(this.rootPath);
            this.dependencyPackage = ReactNativePackageStatus.UNKNOWN;

            XDL.configReactNativeVersionWargnings();
            XDL.attachLoggerStream(this.rootPath, {
                stream: {
                    write: (chunk: any) => {
                        if (chunk.level <= 30) {
                            Log.logString(chunk.msg);
                        } else if (chunk.level === 40) {
                            Log.logWarning(chunk.msg);
                        } else {
                            Log.logError(chunk.msg);
                        }
                    },
                },
                type: "raw",
            });
        }
    }
}
