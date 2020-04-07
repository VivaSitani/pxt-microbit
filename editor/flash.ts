const imul = (Math as any).imul;
const pageSize = 1024;
const numPages = 256;
const timeoutMessage = "timeout"
const membase = 0x20000000
const loadAddr = membase
const dataAddr = 0x20002000
const stackAddr = 0x20001000
const flashPageBINquick = new Uint32Array([
    0xbe00be00, // bkpt - LR is set to this
    0x2480b5f0, 0x00e42300, 0x58cd58c2, 0xd10342aa, 0x42a33304, 0xbdf0d1f8,
    0x4b162502, 0x509d4a16, 0x2d00591d, 0x24a1d0fc, 0x511800e4, 0x3cff3c09,
    0x591e0025, 0xd0fc2e00, 0x509c2400, 0x2c00595c, 0x2401d0fc, 0x509c2580,
    0x595c00ed, 0xd0fc2c00, 0x00ed2580, 0x002e2400, 0x5107590f, 0x2f00595f,
    0x3404d0fc, 0xd1f742ac, 0x50992100, 0x2a00599a, 0xe7d0d0fc, 0x4001e000,
    0x00000504,
])

// doesn't check if data is already there - for timing
const flashPageBIN = new Uint32Array([
    0xbe00be00, // bkpt - LR is set to this
    0x2402b5f0, 0x4a174b16, 0x2480509c, 0x002500e4, 0x2e00591e, 0x24a1d0fc,
    0x511800e4, 0x2c00595c, 0x2400d0fc, 0x2480509c, 0x002500e4, 0x2e00591e,
    0x2401d0fc, 0x595c509c, 0xd0fc2c00, 0x00ed2580, 0x002e2400, 0x5107590f,
    0x2f00595f, 0x3404d0fc, 0xd1f742ac, 0x50992100, 0x2a00599a, 0xbdf0d0fc,
    0x4001e000, 0x00000504,
])

// void computeHashes(uint32_t *dst, uint8_t *ptr, uint32_t pageSize, uint32_t numPages)
const computeChecksums2 = new Uint32Array([
    0x4c27b5f0, 0x44a52680, 0x22009201, 0x91004f25, 0x00769303, 0x24080013,
    0x25010019, 0x40eb4029, 0xd0002900, 0x3c01407b, 0xd1f52c00, 0x468c0091,
    0xa9044665, 0x506b3201, 0xd1eb42b2, 0x089b9b01, 0x23139302, 0x9b03469c,
    0xd104429c, 0x2000be2a, 0x449d4b15, 0x9f00bdf0, 0x4d149e02, 0x49154a14,
    0x3e01cf08, 0x2111434b, 0x491341cb, 0x405a434b, 0x4663405d, 0x230541da,
    0x4b10435a, 0x466318d2, 0x230541dd, 0x4b0d435d, 0x2e0018ed, 0x6002d1e7,
    0x9a009b01, 0x18d36045, 0x93003008, 0xe7d23401, 0xfffffbec, 0xedb88320,
    0x00000414, 0x1ec3a6c8, 0x2f9be6cc, 0xcc9e2d51, 0x1b873593, 0xe6546b64,
])

let startTime = 0
function log(msg: string) {
    let now = Date.now()
    if (!startTime) startTime = now
    now -= startTime
    let ts = ("00000" + now).slice(-5)
    pxt.log(`HID ${ts}: ${msg}`)
}


function murmur3_core(data: Uint8Array) {
    let h0 = 0x2F9BE6CC;
    let h1 = 0x1EC3A6C8;

    for (let i = 0; i < data.length; i += 4) {
        let k = pxt.HF2.read32(data, i) >>> 0
        k = imul(k, 0xcc9e2d51);
        k = (k << 15) | (k >>> 17);
        k = imul(k, 0x1b873593);

        h0 ^= k;
        h1 ^= k;
        h0 = (h0 << 13) | (h0 >>> 19);
        h1 = (h1 << 13) | (h1 >>> 19);
        h0 = (imul(h0, 5) + 0xe6546b64) >>> 0;
        h1 = (imul(h1, 5) + 0xe6546b64) >>> 0;
    }
    return [h0, h1]
}

class DAPWrapper implements pxt.packetio.PacketIOWrapper {
    familyID: number;
    private cortexM: DapJS.CortexM
    private cmsisdap: any;
    private flashing = true;
    private pbuf = new pxt.U.PromiseBuffer<Uint8Array>();
    private useSerial = true;

    constructor(public readonly io: pxt.packetio.PacketIO) {
        this.familyID = 0x0D28; // this is the microbit vendor id, not quite UF2 family id
        this.init();
    }

    private init() {
        this.io.onData = buf => {
            // console.log("RD: " + pxt.Util.toHex(buf))
            this.pbuf.push(buf);
        }

        this.allocDAP()
        const readSerial = () => {
            if (!this.useSerial) {
                return
            }

            if (this.flashing) {
                setTimeout(readSerial, 300)
                return
            }

            this.cmsisdap.cmdNums(0x83, [])
                .then((r: number[]) => {
                    const len = r[1]
                    let str = ""
                    for (let i = 2; i < len + 2; ++i) {
                        str += String.fromCharCode(r[i])
                    }
                    if (str.length > 0) {
                        pxt.U.nextTick(readSerial)
                        if (this.onSerial)
                            this.onSerial(pxt.U.stringToUint8Array(str), false)
                    } else
                        setTimeout(readSerial, 50)
                }, (err: any) => {
                    setTimeout(readSerial, 1000)
                })
        }
        readSerial()
    }

    onSerial: (buf: Uint8Array, isStderr: boolean) => void;

    private allocDAP() {
        /*
        let sendMany = (cmds: Uint8Array[]) => {
            return h.talksAsync(cmds.map(c => ({ cmd: 0, data: c })));
        }

        if (!h.talksAsync)
            sendMany = null;
        */

        let dev = new DapJS.DAP({
            write: writeAsync,
            close: this.disconnectAsync,
            read: readAsync,
            //sendMany: sendMany
        });
        this.cmsisdap = (dev as any).dap;
        this.cortexM = new DapJS.CortexM(dev);

        let h = this.io
        let pbuf = this.pbuf

        function writeAsync(data: ArrayBuffer) {
            // console.log("WR: " + pxt.Util.toHex(new Uint8Array(data)));
            return h.sendPacketAsync(new Uint8Array(data));
        }

        function readAsync() {
            return pbuf.shiftAsync();
        }
    }

    reconnectAsync(first?: boolean) {
        // configure serial at 115200
        let p = Promise.resolve();
        if (!first) {
            p = this.io.reconnectAsync()
                .then(() => this.allocDAP());
        }

        return p
            .then(() => this.cortexM.init())
            .then(() => {
                return this.cmsisdap.cmdNums(0x82, [0x00, 0xC2, 0x01, 0x00])
                    .then(() => { this.useSerial = true }, (err: any) => { this.useSerial = false; });
            });
    }

    disconnectAsync() {
        return this.io.disconnectAsync();
    }

    reflashAsync(resp: pxtc.CompileResult): Promise<void> {
        startTime = 0
        log("init")

        pxt.tickEvent("hid.flash.start");
        this.flashing = true;
        return this.cortexM.init()
            .then(() => this.cortexM.reset(true))
            .catch(e => {
                log("trying re-connect");
                return this.reconnectAsync(false)
                    .then(() => this.cortexM.reset(true));
            })
            .then(() => this.cortexM.memory.readBlock(0x10001014, 1, pageSize))
            .then(v => {
                if (pxt.HF2.read32(v, 0) != 0x3C000) {
                    pxt.tickEvent("hid.flash.uicrfail");
                    return this.fullVendorCommandFlashAsync(resp);
                }
                return this.quickHidFlashAsync(resp);
            });
            /*
            .catch(e => {
                pxt.log(`flash error: ${e.type}`);
                if (e.type === "devicenotfound" && this.reportDeviceNotFoundAsync) {
                    pxt.tickEvent("hid.flash.devicenotfound");
                    return this.options.reportDeviceNotFoundAsync("/device/windows-app/troubleshoot", resp);
                } else if (e.message === timeoutMessage) {
                    pxt.tickEvent("hid.flash.timeout");
                    return this.reconnectAsync(true)
                        .catch((e) => { })
                        .then(() => {
                            // Best effort disconnect; at this point we don't even know the state of the device
                            pxt.reportException(e);
                            return resp.confirmAsync({
                                header: lf("Something went wrong..."),
                                body: lf("One-click download took too long. Please disconnect your {0} from your computer and reconnect it, then manually download your program using drag and drop.", pxt.appTarget.appTheme.boardName || lf("device")),
                                agreeLbl: lf("Ok"),
                                hideCancel: true
                            });
                        })
                        .then(() => {
                            return pxt.commands.saveOnlyAsync(resp);
                        });
                } else if (e.isUserError) {
                    d.reportError(e.message);
                    return Promise.resolve();
                } else {
                    pxt.tickEvent("hid.flash.unknownerror");
                    pxt.reportException(e);
                    return resp.confirmAsync({
                        header: pxt.U.lf("Something went wrong..."),
                        body: pxt.U.lf("Please manually download your program to your device using drag and drop. One-click download might work afterwards."),
                        agreeLbl: lf("Ok"),
                        hideCancel: true
                    })
                        .then(() => {
                            return pxt.commands.saveOnlyAsync(resp);
                        });
                }
            });
            */
    }

    private fullVendorCommandFlashAsync(resp: pxtc.CompileResult): Promise<void> {
        const chunkSize = 62;
        let aborted = false;

        return Promise.resolve()
            .then(() => {
                return this.cmsisdap.cmdNums(0x8A /* DAPLinkFlash.OPEN */, [1]);
            })
            .then((res) => {
                const hexUint8 = pxt.U.stringToUint8Array(resp.outfiles[pxtc.BINARY_HEX]);
                const hexArray: number[] = Array.prototype.slice.call(hexUint8);

                const sendPages = (offset: number = 0): Promise<void> => {
                    const end = Math.min(hexArray.length, offset + chunkSize);
                    const nextPage = hexArray.slice(offset, end);
                    nextPage.unshift(nextPage.length);
                    return this.cmsisdap.cmdNums(0x8C /* DAPLinkFlash.WRITE */, nextPage)
                        .then(() => {
                            if (!aborted && end < hexArray.length) {
                                return sendPages(end);
                            }
                            return Promise.resolve();
                        });
                }

                return sendPages();
            })
            .then((res) => {
                return this.cmsisdap.cmdNums(0x8B /* DAPLinkFlash.CLOSE */, []);
            })
            .timeout(60000, timeoutMessage)
            .catch((e) => {
                aborted = true;
                return this.cmsisdap.cmdNums(0x89 /* DAPLinkFlash.RESET */, [])
                    .catch((e2: any) => {
                        // Best effort reset, no-op if there's an error
                    })
                    .then(() => {
                        return Promise.reject(e);
                    });
            });
    }

    private quickHidFlashAsync(resp: pxtc.CompileResult): Promise<void> {
        let logV = (msg: string) => { }
        //let logV = log
        let aborted = false;

        const runFlash = (b: ts.pxtc.UF2.Block, dataAddr: number) => {
            const cmd = this.cortexM.prepareCommand();

            cmd.halt();

            cmd.writeCoreRegister(DapJS.CortexReg.PC, loadAddr + 4 + 1);
            cmd.writeCoreRegister(DapJS.CortexReg.LR, loadAddr + 1);
            cmd.writeCoreRegister(DapJS.CortexReg.SP, stackAddr);

            cmd.writeCoreRegister(0, b.targetAddr);
            cmd.writeCoreRegister(1, dataAddr);

            return Promise.resolve()
                .then(() => {
                    logV("setregs")
                    return cmd.go()
                })
                .then(() => {
                    logV("dbg en")
                    // starts the program
                    return this.cortexM.debug.enable()
                })
        }

        let checksums: Uint8Array
        return this.getFlashChecksumsAsync()
            .then(buf => {
                checksums = buf;
                log("write code");
                return this.cortexM.memory.writeBlock(loadAddr, flashPageBIN);
            })
            .then(() => {
                log("convert");
                // TODO this is seriously inefficient (130ms on a fast machine)
                let uf2 = ts.pxtc.UF2.newBlockFile();
                ts.pxtc.UF2.writeHex(uf2, resp.outfiles[pxtc.BINARY_HEX].split(/\r?\n/));
                let bytes = pxt.U.stringToUint8Array(ts.pxtc.UF2.serializeFile(uf2));
                let parsed = ts.pxtc.UF2.parseFile(bytes);

                let aligned = DAPWrapper.pageAlignBlocks(parsed, pageSize);
                log(`initial: ${aligned.length} pages`);
                aligned = DAPWrapper.onlyChanged(aligned, checksums);
                log(`incremental: ${aligned.length} pages`);

                return Promise.mapSeries(pxt.U.range(aligned.length),
                    i => {
                        if (aborted) return Promise.resolve();
                        let b = aligned[i];
                        if (b.targetAddr >= 0x10000000)
                            return Promise.resolve();

                        logV("about to write at 0x" + b.targetAddr.toString(16));

                        let writeBl = Promise.resolve();

                        let thisAddr = (i & 1) ? dataAddr : dataAddr + pageSize;
                        let nextAddr = (i & 1) ? dataAddr + pageSize : dataAddr;

                        if (i == 0) {
                            let u32data = new Uint32Array(b.data.length / 4);
                            for (let i = 0; i < b.data.length; i += 4)
                                u32data[i >> 2] = pxt.HF2.read32(b.data, i);
                            writeBl = this.cortexM.memory.writeBlock(thisAddr, u32data);
                        }

                        return writeBl
                            .then(() => runFlash(b, thisAddr))
                            .then(() => {
                                let next = aligned[i + 1];
                                if (!next)
                                    return Promise.resolve();
                                logV("write next");
                                let buf = new Uint32Array(next.data.buffer);
                                return this.cortexM.memory.writeBlock(nextAddr, buf);
                            })
                            .then(() => {
                                logV("wait");
                                return this.cortexM.waitForHalt(500);
                            })
                            .then(() => {
                                logV("done block");
                            });
                    })
                    .then(() => {
                        log("flash done");
                        pxt.tickEvent("hid.flash.done");
                        return this.cortexM.reset(false);
                    })
                    .then(() => {
                        this.flashing = false;
                    });
            })
            .timeout(25000, timeoutMessage)
            .catch((e) => {
                aborted = true;
                return Promise.reject(e);
            });
    }

    private getFlashChecksumsAsync() {
        log("getting existing flash checksums")
        let pages = numPages
        return this.cortexM.runCode(computeChecksums2, loadAddr, loadAddr + 1, 0xffffffff, stackAddr, true,
            dataAddr, 0, pageSize, pages)
            .then(() => this.cortexM.memory.readBlock(dataAddr, pages * 2, pageSize))
    }

    static onlyChanged(blocks: ts.pxtc.UF2.Block[], checksums: Uint8Array) {
        return blocks.filter(b => {
            let idx = b.targetAddr / pageSize
            pxt.U.assert((idx | 0) == idx)
            pxt.U.assert(b.data.length == pageSize)
            if (idx * 8 + 8 > checksums.length)
                return true // out of range?
            let c0 = pxt.HF2.read32(checksums, idx * 8)
            let c1 = pxt.HF2.read32(checksums, idx * 8 + 4)
            let ch = murmur3_core(b.data)
            if (c0 == ch[0] && c1 == ch[1])
                return false
            return true
        })
    }

    static pageAlignBlocks(blocks: ts.pxtc.UF2.Block[], pageSize: number) {
        pxt.U.assert(pageSize % 256 == 0)
        let res: ts.pxtc.UF2.Block[] = []
        for (let i = 0; i < blocks.length;) {
            let b0 = blocks[i]
            let newbuf = new Uint8Array(pageSize)
            let startPad = b0.targetAddr & (pageSize - 1)
            let newAddr = b0.targetAddr - startPad
            for (; i < blocks.length; ++i) {
                let b = blocks[i]
                if (b.targetAddr + b.payloadSize > newAddr + pageSize)
                    break
                pxt.U.memcpy(newbuf, b.targetAddr - newAddr, b.data, 0, b.payloadSize)
            }
            let bb = pxt.U.flatClone(b0)
            bb.data = newbuf
            bb.targetAddr = newAddr
            bb.payloadSize = pageSize
            res.push(bb)
        }
        return res
    }
}

export function mkPacketIOWrapper(io: pxt.packetio.PacketIO): pxt.packetio.PacketIOWrapper {
    return new DAPWrapper(io);
}
