import { ERROR } from "@ethereumjs/vm/dist/exceptions";
import semver from "semver";

import { ErrorInferrer, SubmessageData } from "./error-inferrer";
import {
  adjustStackTrace,
  stackTraceMayRequireAdjustments,
} from "./mapped-inlined-internal-functions-heuristics";
import {
  DecodedCallMessageTrace,
  DecodedCreateMessageTrace,
  DecodedEvmMessageTrace,
  EvmMessageTrace,
  EvmStep,
  isCreateTrace,
  isDecodedCallTrace,
  isDecodedCreateTrace,
  isEvmStep,
  isPrecompileTrace,
  MessageTrace,
  PrecompileMessageTrace,
} from "./message-trace";
import {
  Bytecode,
  ContractFunction,
  ContractFunctionType,
  ContractType,
  Instruction,
  JumpType,
  SourceLocation,
} from "./model";
import { isCall, isCreate, Opcode } from "./opcodes";
import {
  CallFailedErrorStackTraceEntry,
  CallstackEntryStackTraceEntry,
  CONSTRUCTOR_FUNCTION_NAME,
  FALLBACK_FUNCTION_NAME,
  InternalFunctionCallStackEntry,
  OtherExecutionErrorStackTraceEntry,
  RECEIVE_FUNCTION_NAME,
  RevertErrorStackTraceEntry,
  SolidityStackTrace,
  SolidityStackTraceEntry,
  SourceReference,
  StackTraceEntryType,
  UnmappedSolc063RevertErrorStackTraceEntry,
} from "./solidity-stack-trace";

// tslint:disable only-hardhat-error

export class SolidityTracer {
  private _errorInferrer = new ErrorInferrer();

  public getStackTrace(
    maybeDecodedMessageTrace: MessageTrace
  ): SolidityStackTrace {
    if (maybeDecodedMessageTrace.error === undefined) {
      return [];
    }

    if (isPrecompileTrace(maybeDecodedMessageTrace)) {
      return this._getPrecompileMessageStackTrace(maybeDecodedMessageTrace);
    }

    if (isDecodedCreateTrace(maybeDecodedMessageTrace)) {
      return this._getCreateMessageStackTrace(maybeDecodedMessageTrace);
    }

    if (isDecodedCallTrace(maybeDecodedMessageTrace)) {
      return this._getCallMessageStackTrace(maybeDecodedMessageTrace);
    }

    return this._getUnrecognizedMessageStackTrace(maybeDecodedMessageTrace);
  }

  private _getCallMessageStackTrace(
    trace: DecodedCallMessageTrace
  ): SolidityStackTrace {
    const inferredError = this._errorInferrer.inferBeforeTracingCallMessage(
      trace
    );

    if (inferredError !== undefined) {
      return inferredError;
    }

    return this._traceEvmExecution(trace);
  }

  private _getUnrecognizedMessageStackTrace(
    trace: EvmMessageTrace
  ): SolidityStackTrace {
    const subtrace = this._getLastSubtrace(trace);

    if (subtrace !== undefined) {
      // This is not a very exact heuristic, but most of the time it will be right, as solidity
      // reverts if a call fails, and most contracts are in solidity
      if (
        subtrace.error !== undefined &&
        trace.returnData.equals(subtrace.returnData)
      ) {
        let unrecognizedEntry: SolidityStackTraceEntry;

        if (isCreateTrace(trace)) {
          unrecognizedEntry = {
            type: StackTraceEntryType.UNRECOGNIZED_CREATE_CALLSTACK_ENTRY,
          };
        } else {
          unrecognizedEntry = {
            type: StackTraceEntryType.UNRECOGNIZED_CONTRACT_CALLSTACK_ENTRY,
            address: trace.address,
          };
        }

        return [unrecognizedEntry, ...this.getStackTrace(subtrace)];
      }
    }

    if (isCreateTrace(trace)) {
      return [
        {
          type: StackTraceEntryType.UNRECOGNIZED_CREATE_ERROR,
          message: trace.returnData,
        },
      ];
    }

    return [
      {
        type: StackTraceEntryType.UNRECOGNIZED_CONTRACT_ERROR,
        address: trace.address,
        message: trace.returnData,
      },
    ];
  }

  private _getCreateMessageStackTrace(
    trace: DecodedCreateMessageTrace
  ): SolidityStackTrace {
    const inferredError = this._errorInferrer.inferBeforeTracingCreateMessage(
      trace
    );

    if (inferredError !== undefined) {
      return inferredError;
    }

    return this._traceEvmExecution(trace);
  }

  private _getPrecompileMessageStackTrace(
    trace: PrecompileMessageTrace
  ): SolidityStackTrace {
    return [
      {
        type: StackTraceEntryType.PRECOMPILE_ERROR,
        precompile: trace.precompile,
      },
    ];
  }

  private _traceEvmExecution(
    trace: DecodedEvmMessageTrace
  ): SolidityStackTrace {
    const stackTrace = this._rawTraceEvmExecution(trace);

    if (stackTraceMayRequireAdjustments(stackTrace, trace)) {
      return adjustStackTrace(stackTrace, trace);
    }

    return stackTrace;
  }

  private _rawTraceEvmExecution(
    trace: DecodedEvmMessageTrace
  ): SolidityStackTrace {
    const stacktrace: SolidityStackTrace = [];

    let subtracesSeen = 0;
    let jumpedIntoFunction = false;
    const functionJumpdests: Instruction[] = [];

    let lastSubmessageData: SubmessageData | undefined;

    for (let stepIndex = 0; stepIndex < trace.steps.length; stepIndex++) {
      const step = trace.steps[stepIndex];
      const nextStep = trace.steps[stepIndex + 1];

      if (isEvmStep(step)) {
        const inst = trace.bytecode.getInstruction(step.pc);

        if (inst.jumpType === JumpType.INTO_FUNCTION) {
          const nextEvmStep = nextStep as EvmStep; // A jump can't be followed by a subtrace
          const nextInst = trace.bytecode.getInstruction(nextEvmStep.pc);

          if (nextInst !== undefined && nextInst.opcode === Opcode.JUMPDEST) {
            if (jumpedIntoFunction || !isDecodedCallTrace(trace)) {
              stacktrace.push(
                this._instructionToCallstackStackTraceEntry(
                  trace.bytecode,
                  inst
                )
              );
            }

            jumpedIntoFunction = true;
            functionJumpdests.push(nextInst);
          }
        } else if (inst.jumpType === JumpType.OUTOF_FUNCTION) {
          stacktrace.pop();
          functionJumpdests.pop();
        } else if (isCall(inst.opcode) || isCreate(inst.opcode)) {
          // If a call can't be executed, we don't get an execution trace from it. We can detect
          // this by checking if the next step is an EvmStep.

          // fvtodo mover esto y el stacktrace.pop del else a la logica
          // de encadenar errores en el inferrer
          if (nextStep === undefined || !isEvmStep(nextStep)) {
            stacktrace.push(
              this._instructionToCallstackStackTraceEntry(trace.bytecode, inst)
            );
          }
        }
      } else {
        subtracesSeen += 1;

        // If there are more subtraces, this one didn't terminate the execution
        if (subtracesSeen < trace.numberOfSubtraces) {
          stacktrace.pop();
          continue;
        }

        const submessageTrace = this.getStackTrace(step);

        lastSubmessageData = {
          message: step,
          stepIndex,
          trace: submessageTrace,
        };
      }
    }

    const stacktraceWithInferredError = this._errorInferrer.inferAfterTracing(
      trace,
      stacktrace,
      jumpedIntoFunction,
      lastSubmessageData,
      functionJumpdests
    );

    return stacktraceWithInferredError;
  }

  // Heuristics

  private _isSubtraceErrorPropagated(
    trace: DecodedEvmMessageTrace,
    callSubtraceStepIndex: number
  ): boolean {
    const call = trace.steps[callSubtraceStepIndex] as MessageTrace;

    if (!trace.returnData.equals(call.returnData)) {
      return false;
    }

    if (
      trace.error?.error === ERROR.OUT_OF_GAS &&
      call.error?.error === ERROR.OUT_OF_GAS
    ) {
      return true;
    }

    return this._failsRightAfterCall(trace, callSubtraceStepIndex);
  }

  private _isContractCallRunOutOfGasError(
    trace: DecodedEvmMessageTrace,
    callStepIndex: number
  ): boolean {
    if (trace.returnData.length > 0) {
      return false;
    }

    if (trace.error?.error !== ERROR.REVERT) {
      return false;
    }

    const call = trace.steps[callStepIndex] as MessageTrace;
    if (call.error?.error !== ERROR.OUT_OF_GAS) {
      return false;
    }

    return this._failsRightAfterCall(trace, callStepIndex);
  }

  private _failsRightAfterCall(
    trace: DecodedEvmMessageTrace,
    callSubtraceStepIndex: number
  ): boolean {
    const lastStep = trace.steps[trace.steps.length - 1];
    if (!isEvmStep(lastStep)) {
      return false;
    }

    const lastInst = trace.bytecode.getInstruction(lastStep.pc);
    if (lastInst.opcode !== Opcode.REVERT) {
      return false;
    }

    const callOpcodeStep = trace.steps[callSubtraceStepIndex - 1] as EvmStep;
    const callInst = trace.bytecode.getInstruction(callOpcodeStep.pc);

    return this._isLastLocation(
      trace,
      callSubtraceStepIndex + 1,
      callInst.location! // Calls are always made from within functions
    );
  }

  private _isProxyErrorPropagated(
    trace: DecodedCallMessageTrace,
    callSubtraceStepIndex: number
  ): boolean {
    const callStep = trace.steps[callSubtraceStepIndex - 1];
    if (!isEvmStep(callStep)) {
      return false;
    }

    const callInst = trace.bytecode.getInstruction(callStep.pc);
    if (callInst.opcode !== Opcode.DELEGATECALL) {
      return false;
    }

    const subtrace = trace.steps[callSubtraceStepIndex];
    if (isEvmStep(subtrace)) {
      return false;
    }

    if (isPrecompileTrace(subtrace)) {
      return false;
    }

    // If we can't recognize the implementation we'd better don't consider it as such
    if (subtrace.bytecode === undefined) {
      return false;
    }

    if (subtrace.bytecode.contract.type === ContractType.LIBRARY) {
      return false;
    }

    if (!trace.returnData.equals(subtrace.returnData)) {
      return false;
    }

    for (let i = callSubtraceStepIndex + 1; i < trace.steps.length; i++) {
      const step = trace.steps[i];
      if (!isEvmStep(step)) {
        return false;
      }

      const inst = trace.bytecode.getInstruction(step.pc);

      // All the remaining locations should be valid, as they are part of the inline asm
      if (inst.location === undefined) {
        return false;
      }

      if (
        inst.jumpType === JumpType.INTO_FUNCTION ||
        inst.jumpType === JumpType.OUTOF_FUNCTION
      ) {
        return false;
      }
    }

    const lastStep = trace.steps[trace.steps.length - 1] as EvmStep;
    const lastInst = trace.bytecode.getInstruction(lastStep.pc);

    return lastInst.opcode === Opcode.REVERT;
  }

  // Stack trace entry factories

  private _instructionToCallstackStackTraceEntry(
    bytecode: Bytecode,
    inst: Instruction
  ): CallstackEntryStackTraceEntry | InternalFunctionCallStackEntry {
    // This means that a jump is made from within an internal solc function.
    // These are normally made from yul code, so they don't map to any Solidity
    // function
    if (inst.location === undefined) {
      return {
        type: StackTraceEntryType.INTERNAL_FUNCTION_CALLSTACK_ENTRY,
        pc: inst.pc,
        sourceReference: {
          file: bytecode.contract.location.file,
          contract: bytecode.contract.name,
          function: undefined,
          line: bytecode.contract.location.getStartingLineNumber(),
        },
      };
    }

    const func = inst.location!.getContainingFunction();

    if (func !== undefined) {
      return {
        type: StackTraceEntryType.CALLSTACK_ENTRY,
        sourceReference: this._sourceLocationToSourceReference(
          bytecode,
          inst.location
        )!,
        functionType: func.type,
      };
    }

    return {
      type: StackTraceEntryType.CALLSTACK_ENTRY,
      sourceReference: {
        function: undefined,
        contract: bytecode.contract.name,
        file: inst.location!.file,
        line: inst.location!.getStartingLineNumber(),
      },
      functionType: ContractFunctionType.FUNCTION,
    };
  }

  // Source reference factories

  // fvtodo deduplicate this
  private _sourceLocationToSourceReference(
    bytecode: Bytecode,
    location?: SourceLocation
  ): SourceReference | undefined {
    if (location === undefined) {
      return undefined;
    }

    const func = location.getContainingFunction();

    if (func === undefined) {
      return undefined;
    }

    let funcName = func.name;

    if (func.type === ContractFunctionType.CONSTRUCTOR) {
      funcName = CONSTRUCTOR_FUNCTION_NAME;
    } else if (func.type === ContractFunctionType.FALLBACK) {
      funcName = FALLBACK_FUNCTION_NAME;
    } else if (func.type === ContractFunctionType.RECEIVE) {
      funcName = RECEIVE_FUNCTION_NAME;
    }

    return {
      function: funcName,
      contract: bytecode.contract.name,
      file: func.location.file,
      line: location.getStartingLineNumber(),
    };
  }

  // Utils

  private _getLastSubtrace(trace: EvmMessageTrace): MessageTrace | undefined {
    if (trace.numberOfSubtraces < 1) {
      return undefined;
    }

    let i = trace.steps.length - 1;

    while (isEvmStep(trace.steps[i])) {
      i -= 1;
    }

    return trace.steps[i] as MessageTrace;
  }

  private _isLastLocation(
    trace: DecodedEvmMessageTrace,
    fromStep: number,
    location: SourceLocation
  ): boolean {
    for (let i = fromStep; i < trace.steps.length; i++) {
      const step = trace.steps[i];

      if (!isEvmStep(step)) {
        return false;
      }

      const stepInst = trace.bytecode.getInstruction(step.pc);

      if (stepInst.location === undefined) {
        continue;
      }

      if (!location.equals(stepInst.location)) {
        return false;
      }
    }

    return true;
  }
}
