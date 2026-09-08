import { randomUUID } from 'crypto';
import { pathComparisonKey } from './pathSafety';

interface ExpectedEvent {operationId:string;expectedHash?:string}

/** Suppresses only an event whose observed content exactly matches our operation. */
export class OperationEventSuppressor {
    private readonly expected=new Map<string,ExpectedEvent[]>();

    register(side:'local'|'remote',path:string,expectedHash?:string,operationId:string=randomUUID()):string {
        const key=`${side}:${pathComparisonKey(path)}`;
        const values=this.expected.get(key)??[];
        values.push({operationId,expectedHash});
        this.expected.set(key,values);
        return operationId;
    }

    consume(side:'local'|'remote',path:string,observedHash?:string):string|undefined {
        const key=`${side}:${pathComparisonKey(path)}`;
        const values=this.expected.get(key);
        const index=values?.findIndex(item=>item.expectedHash===observedHash)??-1;
        if (!values || index<0) { return undefined; }
        const [matched]=values.splice(index,1);
        if (!values.length) { this.expected.delete(key); }
        return matched.operationId;
    }

    clear(side:'local'|'remote',path:string,operationId:string):void {
        const key=`${side}:${pathComparisonKey(path)}`;
        const remaining=(this.expected.get(key)??[]).filter(item=>item.operationId!==operationId);
        if (remaining.length) { this.expected.set(key,remaining); } else { this.expected.delete(key); }
    }
}
