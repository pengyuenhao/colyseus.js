import { Signal } from '@gamestdio/signals';
import * as msgpack from './msgpack';
import { Schema } from '@colyseus/schema';

import { Connection } from './Connection';
import { Serializer, getSerializer } from './serializer/Serializer';
import { Protocol, utf8Read, utf8Length } from './Protocol';

import { FossilDeltaSerializer } from './serializer/FossilDeltaSerializer';
import { Listener } from '@gamestdio/state-listener';
import { SchemaSerializer } from '.';
import { RootSchemaConstructor } from './serializer/SchemaSerializer';

export interface RoomAvailable {
    roomId: string;
    clients: number;
    maxClients: number;
    metadata?: any;
}

export class Room<State= any> {
    public id: string;
    public sessionId: string;

    public name: string;
    public options: any;

    // Public signals
    public onJoin: Signal = new Signal();
    public onStateChange: Signal = new Signal();
    public onMessage: Signal = new Signal();
    public onError: Signal = new Signal();
    public onLeave: Signal = new Signal();

    public connection: Connection;

    public serializerId: string;
    protected serializer: Serializer<State>;

    protected previousCode: Protocol;

    // TODO: remove me on 1.0.0
    protected rootSchema: RootSchemaConstructor;

    constructor(name: string, options?: any, rootSchema?: RootSchemaConstructor) {
        this.id = null;

        this.name = name;
        this.options = options;

        if (rootSchema) {
            this.serializer = new (getSerializer("schema"));
            this.rootSchema = rootSchema;
            (this.serializer as SchemaSerializer).state = new (rootSchema)();

        } else {
            // TODO: remove default serializer. it should arrive only after JOIN_ROOM.
            this.serializer = new (getSerializer("fossil-delta"));
        }

        this.onLeave.add(() => this.removeAllListeners());
    }

    public connect(endpoint: string) {
        this.connection = new Connection(endpoint, false);
        this.connection.reconnectEnabled = false;
        this.connection.onmessage = this.onMessageCallback.bind(this);
        this.connection.onclose = (e) => this.onLeave.dispatch(e);
        this.connection.onerror = (e) => {
            console.warn(`Possible causes: room's onAuth() failed or maxClients has been reached.`);
            this.onError.dispatch(e);
        };
        this.connection.open();
    }

    public leave(consented: boolean = true): void {
        if (this.connection) {
            if (consented) {
                this.connection.send([Protocol.LEAVE_ROOM]);

            } else {
                this.connection.close();
            }
        } else {
            this.onLeave.dispatch();
        }
    }

    public send(data): void {
        this.connection.send([ Protocol.ROOM_DATA, this.id, data ]);
    }

    public get state (): State {
        return this.serializer.getState();
    }

    public get hasJoined() {
        return this.sessionId !== undefined;
    }

    // TODO: deprecate / move somewhere else
    // this method is useful only for FossilDeltaSerializer
    public listen(segments: string, callback: Function, immediate?: boolean) {
        if (this.serializerId === "schema") {
            console.error(`'${this.serializerId}' serializer doesn't support .listen() method.`);
            return;

        } else if (!this.serializerId) {
            console.warn("room.Listen() should be called after room.onJoin has been called (DEPRECATION WARNING)");
        }

        return (this.serializer as FossilDeltaSerializer<State>).api.listen(segments, callback, immediate);
    }

    // TODO: deprecate / move somewhere else
    // this method is useful only for FossilDeltaSerializer
    public removeListener(listener: Listener) {
        return (this.serializer as FossilDeltaSerializer<State>).api.removeListener(listener)
    }

    public removeAllListeners() {
        if (this.serializer) {
            this.serializer.teardown();
        }
        this.onJoin.removeAll();
        this.onStateChange.removeAll();
        this.onMessage.removeAll();
        this.onError.removeAll();
        this.onLeave.removeAll();
    }

    protected onMessageCallback(event: MessageEvent) {
        if (!this.previousCode) {
            const view = new DataView(event.data);
            const code = view.getUint8(0);

            if (code === Protocol.JOIN_ROOM) {
                let offset = 1;

                this.sessionId = utf8Read(view, offset);
                offset += utf8Length(this.sessionId);

                this.serializerId = utf8Read(view, offset);
                offset += utf8Length(this.serializerId);

                // get serializer implementation
                const serializer = getSerializer(this.serializerId);
                if (!serializer) {
                    throw new Error("missing serializer: " + this.serializerId);
                }

                // TODO: remove this check
                if (this.serializerId !== "fossil-delta" && !this.rootSchema) {
                    this.serializer = new serializer();
                }

                if (view.buffer.byteLength > offset && this.serializer.handshake) {
                    const bytes = Array.from(new Uint8Array(view.buffer.slice(offset)));
                    this.serializer.handshake(bytes);
                }

                this.onJoin.dispatch();

            } else if (code === Protocol.JOIN_ERROR) {
                this.onError.dispatch(utf8Read(view, 1));

            } else if (code === Protocol.LEAVE_ROOM) {
                this.leave();

            } else {
                this.previousCode = code;
            }

        } else {
            if (this.previousCode === Protocol.ROOM_STATE) {
                // TODO: improve here!
                this.setState(Array.from(new Uint8Array(event.data)));

            } else if (this.previousCode === Protocol.ROOM_STATE_PATCH) {
                this.patch(Array.from(new Uint8Array(event.data)));

            } else if (this.previousCode === Protocol.ROOM_DATA) {
                this.onMessage.dispatch(msgpack.decode(event.data));
            }

            this.previousCode = undefined;
        }
    }

    protected setState(encodedState): void {
        this.serializer.setState(encodedState);
        this.onStateChange.dispatch(this.serializer.getState());
    }

    protected patch(binaryPatch) {
        this.serializer.patch(binaryPatch);
        this.onStateChange.dispatch(this.serializer.getState());
    }

}
