import * as path from "path";
import * as vscode from "vscode";
import { Global } from "../common/global";
import { Node } from "../model/interface/node";
import { QueryUnit } from "./queryUnit";
import { SSHConfig } from "../model/interface/sshConfig";
import { DatabaseCache } from "./common/databaseCache";
import { NodeUtil } from "../model/nodeUtil";
import { SSHTunnelService } from "./common/sshTunnelService";
import { DbTreeDataProvider } from "../provider/treeDataProvider";
import { create, IConnection } from "./connect/connection";

interface ConnectionWrapper {
    connection: IConnection;
    ssh: SSHConfig;
    database?: string
}

export interface GetRequest {
    retryCount?: number;
    sessionId?: string;
}

export class ConnectionManager {

    private static activeNode: Node;
    private static alivedConnection: { [key: string]: ConnectionWrapper } = {};
    private static tunnelService = new SSHTunnelService();

    public static getLastConnectionOption(checkActiveFile = true): Node {

        if (checkActiveFile) {
            const fileNode = this.getByActiveFile()
            if (fileNode) { return fileNode }
        }

        const node = this.activeNode;
        if (!node && checkActiveFile) {
            vscode.window.showErrorMessage("Not active database connection found!")
            throw new Error("Not active database connection found!")
        }

        return node;
    }

    public static getActiveConnectByKey(key: string): ConnectionWrapper {
        return this.alivedConnection[key]
    }

    public static removeConnection(uid: string) {

        const lcp = this.activeNode;
        if (lcp?.getConnectId() == uid) {
            delete this.activeNode
        }
        const activeConnect = this.alivedConnection[uid];
        if (activeConnect) {
            this.end(uid, activeConnect)
        }
        DatabaseCache.clearDatabaseCache(uid)

    }

    public static changeActive(connectionNode: Node) {
        this.activeNode = connectionNode;
        Global.updateStatusBarItems(connectionNode);
        DbTreeDataProvider.refresh()
    }

    public static getConnection(connectionNode: Node, getRequest: GetRequest = { retryCount: 1 }): Promise<IConnection> {
        if (!connectionNode) {
            throw new Error("Connection is dead!")
        }
        return new Promise(async (resolve, reject) => {

            NodeUtil.of(connectionNode)
            if (!getRequest.retryCount) getRequest.retryCount = 1;
            const key = getRequest.sessionId || connectionNode.getConnectId({ withDb: true });
            const connection = this.alivedConnection[key];
            if (connection) {
                if (connection.connection.isAlive()) {
                    if (connection.database != connectionNode.database) {
                        const sql = connectionNode?.dialect?.pingDataBase(connectionNode.database);
                        try {
                            if (sql) {
                                await QueryUnit.queryPromise(connection.connection, sql, false)
                            }
                            connection.database = connectionNode.database
                            resolve(connection.connection);
                            return;
                        } catch (err) {
                            ConnectionManager.end(key, connection);
                        }
                    } else {
                        resolve(connection.connection);
                        return;
                    }
                }
            }

            const ssh = connectionNode.ssh;
            let connectOption = connectionNode;
            if (connectOption.usingSSH) {
                connectOption = await this.tunnelService.createTunnel(connectOption, (err) => {
                    if (err.errno == 'EADDRINUSE') { return; }
                    this.alivedConnection[key] = null
                })
                if (!connectOption) {
                    reject("create ssh tunnel fail!");
                    return;
                }
            }
            const newConnection = create(connectOption);
            this.alivedConnection[key] = { connection: newConnection, ssh, database: connectionNode.database };
            newConnection.connect(async (err: Error) => {
                if (err) {
                    this.end(key, this.alivedConnection[key])
                    if (getRequest.retryCount >= 2) {
                        reject(err)
                    } else {
                        try {
                            getRequest.retryCount++;
                            resolve(await this.getConnection(connectionNode, getRequest))
                        } catch (error) {
                            reject(error)
                        }
                    }
                } else {
                    resolve(newConnection);
                }
            });

        });

    }

    private static end(key: string, connection: ConnectionWrapper) {
        this.alivedConnection[key] = null
        try {
            this.tunnelService.closeTunnel(key)
            connection.connection.end();
        } catch (error) {
        }
    }

    public static getByActiveFile(): Node {
        if (vscode.window.activeTextEditor) {
            const fileName = vscode.window.activeTextEditor.document.fileName;
            if (fileName.includes('cweijan')) {
                const queryName = path.basename(fileName, path.extname(fileName))
                const filePattern = queryName.replace(/#.+$/, '').split('_');
                const [mode, host, port, user] = filePattern
                let database: string;
                if (filePattern.length >= 5) {
                    database = filePattern[4]
                    // fix if database name has _, loop append
                    if (filePattern.length >= 5) {
                        for (let index = 5; index < filePattern.length; index++) {
                            database = `${database}_${filePattern[index]}`
                        }
                    }
                }
                if (host != null && port != null && user != null) {
                    const node = NodeUtil.of({ host, port: parseInt(port), user, database });
                    if (node.getCache()) {
                        return node.getCache();
                    }
                }
            }
        }
        return null;
    }

}
