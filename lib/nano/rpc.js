const axios = require("axios")
const { nodes, workers } = require("./config")
const { BASE_DIFFICULTY } = require('./work')
const { hashBlock } = require("./block")

const TIMEOUT = 1000 * 5 // 5 seconds
const FALLBACK_TRIES = 3
const FALLBACK_SLEEP = 1000 * 5 // 5 seconds

let node_counter = 0
// If there is one more address after the current one, return it. Otherwise back to the first (0)
function nextNode() {
    (node_counter + 1) > (nodes.length - 1) ? node_counter = 0 : node_counter++
}

/*
    With a fallback we rely on alternative nodes when the first one has some error such as: 
        - Not responding
        - Returns a server error
        - Returns an invalid format response.
    As the method Promise.any is only supported in node.js >= v15.0, so let's create an alternative function
    But instead of an array, we use an object to identify the URL of each promise.
*/
const rpcFallback = (data, urls = nodes, count = 1) => {
    return new Promise((resolve, reject) => {

        const sleep = (ms) => {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        let requests = {}, result = { fulfilled: [], rejected: [] }

        // Resolve with the first fulfilled promise or push rejected promises
        for (let i = 0; i < urls.length; i++) {
            requests[urls[i]] = postRPC(data, urls[i], true)
            requests[urls[i]]
                .then((res) => {
                    result.fulfilled.length ? null : resolve(res)
                    result.fulfilled.push(res)
                }).catch((err) => result.rejected.push(err))
        }

        // Reject with the first url error if all promises were rejected
        Promise.allSettled(Object.values(requests))
            .then(() => {
                if (result.rejected.length == Object.keys(requests).length) {
                    if (count < FALLBACK_TRIES) {
                        count++
                        sleep(FALLBACK_SLEEP)
                            .then(() => {
                                rpcFallback(data, urls, count)
                                    .then(resolve)
                                    .catch(reject)
                            })
                    } else {
                        requests[urls[0]]
                            .catch((defaultErr) => {
                                reject(defaultErr)
                            })
                    }
                }
            })

    })
}

const postRPC = (data, nodeAddresses = nodes) => {
    return new Promise((resolve, reject) => {

        // By defautl, postRPC receive a list of rpc node addresses.
        // But in fallback, it receives a single node address
        // Sometimes the url will be an RPC node, sometimes a worker.
        let nodeAddress, fallbacking
        if (typeof(nodeAddresses) == "object") {
            fallbacking = false
            nodeAddress = nodeAddresses[0]
        } else if (typeof(nodeAddresses) == "string") {
            fallbacking = true
            nodeAddress = nodeAddresses
        }

        console.log(data)

        axios({
            method: "post",
            url: nodeAddress,
            timeout: TIMEOUT,
            headers: {
                "Content-Type": "application/json"
            },
            data: data
        })
            .then((res) => {
                if (typeof res.data === 'object') {
                    if ("error" in res.data) {
                        console.error("Node Error " + JSON.stringify(res.data.error))
                        reject(res.data)
                    } else {
                        resolve(res.data)
                    }
                } else {
                    console.error(`Invalid node response (${nodeAddress})`)
                    if (!fallbacking, nodeAddresses) {
                        rpcFallback(data)
                            .then(resolve)
                            .catch(reject)
                    } else {
                        reject("Invalid node response")
                    }
                }
            }).catch((err) => {
                if (err.response) {
                    console.error(`Node Response Error (${nodeAddress}): ${JSON.stringify(err.response.data)}`)
                    reject(err.response.data)
                } else if (err.request) {
                    console.error(`No response from node (${nodeAddress})`)
                    if (!fallbacking) {
                        rpcFallback(data, nodeAddresses)
                            .then(resolve)
                            .catch(reject)
                    } else {
                        reject("No response from node")
                    }
                } else {
                    console.error(`Node Response Error (${nodeAddress}): ${JSON.stringify(err.message)}`)
                    reject(err.message)
                }
            })
    })
}

export function work_generate(hash, difficulty = BASE_DIFFICULTY) {
    return new Promise((resolve, reject) => {
        const data = {
            action: "work_generate",
            hash: hash,
            difficulty: difficulty
        }
        postRPC(data, workers)
            .then(resolve)
            .catch(reject)
    })
}

export function broadcast(block_json) {
    return new Promise((resolve, reject) => {
        const data = {
            "action": "process",
            "json_block": "true",
            "block": block_json
        }
        const block_hash = hashBlock(block_json)
        postRPC(data)
            .then((res) => {
                if ("hash" in res) {
                    if (res.hash == block_hash) {
                        resolve(res)
                    } else {
                        reject("block hash invalid returned")
                    }
                } else {
                    reject("block hash not present, response: " + JSON.stringify(res))
                }
            }).catch(reject)
    })
}

export function account_info(account) {
    return new Promise((resolve, reject) => {
        const data = {
            "action": "account_info",
            "account": account,
            "representative": "true",
            "weight": "true",
            "pending": "true"
        }

        postRPC(data)
            .then((res) => {
                try {
                    let info = {
                        account: account,
                        frontier: res.frontier,
                        open_block: res.open_block,
                        representative_block: res.representative_block,
                        balance: res.balance,
                        modified_timestamp: res.modified_timestamp,
                        block_count: res.block_count,
                        representative: res.representative,
                        weight: res.weight,
                        pending: res.pending
                    }
                    resolve(info)

                } catch (err) {
                    reject(err)
                }
            }).catch((err) => {
                if (typeof (err) === "object" && "error" in err && err.error == 'Account not found') {
                    account_balance(account)
                        .then((res) => {
                            const info = {
                                account: account,
                                frontier: "0000000000000000000000000000000000000000000000000000000000000000",
                                open_block: null,
                                representative_block: null,
                                balance: "0",
                                modified_timestamp: null,
                                block_count: "0",
                                representative: null,
                                weight: "0",
                                pending: res.pending
                            }
                            resolve(info)
                        })
                        .catch(reject)
                } else {
                    reject(err)
                }
            })
    })
}

export function account_balance(account) {
    return new Promise((resolve, reject) => {
        const data = {
            "action": "account_balance",
            "account": account
        }
        postRPC(data)
            .then((res) => {
                try {
                    resolve({ balance: res.balance, pending: res.pending })
                } catch (err) {
                    reject(err)
                }
            }).catch(reject)
    })
}

export function block_info(hash) {
    return new Promise((resolve, reject) => {
        let data = {
            "action": "block_info",
            "json_block": "true",
            "hash": hash
        }
        postRPC(data)
            .then((res) => {
                if ("contents" in res) {
                    try {
                        let block = res.contents
                        block.amount = res.amount
                        block.hash = hash
                        block.local_timestamp = res.local_timestamp
                        block.subtype = res.subtype
                        resolve(block)
                    } catch (err) {
                        reject(err)
                    }
                } else {
                    reject("block not found")
                }
            }).catch(reject)
    })
}

export function pending_blocks(account, threshold = 0) {
    return new Promise((resolve, reject) => {
        const data = {
            "action": "pending",
            "account": account,
            "count": -1,
            "threshold": threshold
        }

        postRPC(data)
            .then((res) => {
                if (!("blocks" in res)) return reject("invalid node response")
                try {
                    resolve(res.blocks)
                } catch (err) {
                    reject(err)
                }
            }).catch(reject)
    })
}

export function account_history(account, options = false) {
    return new Promise((resolve, reject) => {
        let data = {
            "action": "account_history",
            "account": account,
            "count": -1
        }
        if (options) {
            if (options.raw) data.raw = options.raw
            if (options.head) data.head = options.head
            if (options.offset) data.offset = options.offset
            if (options.reverse) data.reverse = options.reverse
        }
        postRPC(data)
            .then((res) => {
                try {
                    resolve(res.history)
                } catch (err) {
                    reject(err)
                }
            }).catch((err) => {
                if (typeof (err) === "object" && "error" in err && err.error.includes("Account not found")) {
                    resolve("")
                } else {
                    reject(err)
                }
            })
    })
}