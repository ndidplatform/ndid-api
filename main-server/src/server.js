/**
 * Copyright (c) 2018, 2019 National Digital ID COMPANY LIMITED
 *
 * This file is part of NDID software.
 *
 * NDID is the free software: you can redistribute it and/or modify it under
 * the terms of the Affero GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or any later
 * version.
 *
 * NDID is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Affero GNU General Public License for more details.
 *
 * You should have received a copy of the Affero GNU General Public License
 * along with the NDID source code. If not, see https://www.gnu.org/licenses/agpl.txt.
 *
 * Please contact info@ndid.co.th for any further questions
 *
 */

import 'source-map-support/register';

import 'dotenv/config';
import mkdirp from 'mkdirp';

import './env_var_validate';

import * as httpServer from './http_server';
import * as node from './node';
import * as core from './core/common';
import * as rp from './core/rp';
import * as idp from './core/idp';
import * as as from './core/as';
import * as proxy from './core/proxy';
import * as nodeKey from './utils/node_key';

import * as cacheDb from './db/cache';
import * as longTermDb from './db/long_term';
import * as dataDb from './db/data';
import * as tendermint from './tendermint';
import * as tendermintWsPool from './tendermint/ws_pool';
import * as mq from './mq';
import * as callbackUtil from './utils/callback';
import * as externalCryptoService from './utils/external_crypto_service';
import { initialize as masterInitialize } from './master-worker-interface/server';
import { initialize as workerInitialize } from './master-worker-interface/client';
import * as prometheus from './prometheus';

import logger from './logger';

import * as config from './config';

process.on('unhandledRejection', function(reason, p) {
  if (reason && reason.name === 'CustomError') {
    logger.error({
      message: 'Unhandled Rejection',
      p,
    });
    logger.error(reason.getInfoForLog());
  } else {
    logger.error({
      message: 'Unhandled Rejection',
      p,
      reason: reason.stack || reason,
    });
  }
});

async function initialize() {
  logger.info({ message: 'Initializing server' });
  try {
    tendermint.loadSavedData();

    await Promise.all([cacheDb.initialize(), longTermDb.initialize()]);

    if (config.prometheusEnabled) {
      prometheus.initialize();
    }

    if (config.ndidNode) {
      tendermint.setWaitForInitEndedBeforeReady(false);
    }
    tendermint.setTxResultCallbackFnGetter(core.getFunction);

    const tendermintReady = new Promise((resolve) =>
      tendermint.eventEmitter.once('ready', (status) => resolve(status))
    );

    await tendermint.connectWS();
    const tendermintStatusOnSync = await tendermintReady;

    let role;
    if (!config.ndidNode) {
      logger.info({ message: 'Getting node role' });
      role = await node.getNodeRoleFromBlockchain();
      logger.info({ message: 'Node role', role });
    }

    if (role === 'rp') {
      mq.setMessageHandlerFunction(rp.handleMessageFromQueue);
      tendermint.setTendermintNewBlockEventHandler(rp.handleTendermintNewBlock);
      await rp.checkCallbackUrls();
    } else if (role === 'idp') {
      mq.setMessageHandlerFunction(idp.handleMessageFromQueue);
      tendermint.setTendermintNewBlockEventHandler(
        idp.handleTendermintNewBlock
      );
      await idp.checkCallbackUrls();
    } else if (role === 'as') {
      mq.setMessageHandlerFunction(as.handleMessageFromQueue);
      tendermint.setTendermintNewBlockEventHandler(as.handleTendermintNewBlock);
      await as.checkCallbackUrls();
    } else if (role === 'proxy') {
      mq.setMessageHandlerFunction(proxy.handleMessageFromQueue);
      tendermint.setTendermintNewBlockEventHandler(
        proxy.handleTendermintNewBlock
      );
      await rp.checkCallbackUrls();
      await idp.checkCallbackUrls();
      await as.checkCallbackUrls();
    }

    callbackUtil.setShouldRetryFnGetter(core.getFunction);
    callbackUtil.setResponseCallbackFnGetter(core.getFunction);

    let externalCryptoServiceReady;
    if (config.useExternalCryptoService) {
      await externalCryptoService.checkCallbackUrls();
      if (!(await externalCryptoService.isCallbackUrlsSet())) {
        externalCryptoServiceReady = new Promise((resolve) =>
          externalCryptoService.eventEmitter.once('allCallbacksSet', () =>
            resolve()
          )
        );
      }
    } else {
      await nodeKey.initialize();
    }

    if(!config.isMaster) httpServer.initialize();

    if (externalCryptoServiceReady != null) {
      logger.info({ message: 'Waiting for DPKI callback URLs to be set' });
      await externalCryptoServiceReady;
    }

    if (role === 'rp' || role === 'idp' || role === 'as' || role === 'proxy') {
      mq.setErrorHandlerFunction(core.handleMessageQueueError, () => {
        // FIXME ?
        if (role === 'rp') {
          rp.getErrorCallbackUrl();
        } else if (role === 'idp') {
          idp.getErrorCallbackUrl();
        } else if (role === 'as') {
          as.getErrorCallbackUrl();
        }
      });
      if(config.isMaster) {
        await mq.initializeInbound();
      }
      else {
        await mq.initializeOutbound(false);
      }
    }

    await tendermint.initialize();

    if (role === 'rp' || role === 'idp' || role === 'proxy') {
      let nodeIds;
      if (role === 'rp') {
        nodeIds = [config.nodeId];
      } else if (role === 'idp') {
        nodeIds = [config.nodeId];
      } else if (role === 'proxy') {
        const nodesBehindProxy = await node.getNodesBehindProxyWithKeyOnProxy();
        nodeIds = nodesBehindProxy.map((node) => node.node_id);
      }
      await core.resumeTimeoutScheduler(nodeIds);
    }

    if (role === 'rp' || role === 'idp' || role === 'as' || role === 'proxy') {
      if(!config.isMaster) await core.setMessageQueueAddress();
      else await mq.loadAndProcessBacklogMessages();
    }

    if(config.isMaster) {
      tendermint.processMissingBlocks(tendermintStatusOnSync);
      await tendermint.loadExpectedTxFromDB();
      tendermint.loadAndRetryBacklogTransactRequests();

      callbackUtil.resumeCallbackToClient();
    }

    if(config.isMaster) await masterInitialize();
    else await workerInitialize();

    logger.info({ message: 'Server initialized' });
  } catch (error) {
    logger.error({
      message: 'Cannot initialize server',
      error,
    });
    // shutDown();
  }
}

const {
  privateKeyPassphrase, // eslint-disable-line no-unused-vars
  masterPrivateKeyPassphrase, // eslint-disable-line no-unused-vars
  dbPassword, // eslint-disable-line no-unused-vars
  ...configToLog
} = config;
logger.info({
  message: 'Starting server',
  NODE_ENV: process.env.NODE_ENV,
  config: configToLog,
});

// Make sure data and log directories exist
mkdirp.sync(config.dataDirectoryPath);
mkdirp.sync(config.logDirectoryPath);

// Graceful Shutdown
let shutDownCalledOnce = false;
async function shutDown() {
  if (shutDownCalledOnce) {
    logger.error({
      message: 'Forcefully shutting down',
    });
    process.exit(1);
  }
  shutDownCalledOnce = true;

  logger.info({
    message: 'Received kill signal, shutting down gracefully',
  });
  console.log('(Ctrl+C again to force shutdown)');

  await prometheus.stop();
  await httpServer.close();
  callbackUtil.stopAllCallbackRetries();
  externalCryptoService.stopAllCallbackRetries();
  await mq.close();
  tendermint.tendermintWsClient.close();
  tendermintWsPool.closeAllConnections();
  // TODO: wait for async operations which going to use DB to finish before closing
  // a connection to DB
  // Possible solution: Have those async operations append a queue to use DB and
  // remove after finish using DB
  // => Wait here until a queue to use DB is empty
  await Promise.all([cacheDb.close(), longTermDb.close(), dataDb.close()]);
  core.stopAllTimeoutScheduler();
}

process.on('SIGTERM', shutDown);
process.on('SIGINT', shutDown);

initialize();
